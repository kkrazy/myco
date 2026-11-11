/*
 * bench_stock.c — 原版 LZ4 对照基准（stock lz4 v1.10.1，无调优宏）。
 *
 * 与 bench_mt.c 同口径：4KB 逐块、每文件验证 + 3 次迭代吞吐、
 * 输出列完全对齐，便于 run_lz4.sh 并排对照。
 *
 * 计时用 CLOCK_PROCESS_CPUTIME_ID（与 sol/scripts/bench_lz4.c 及
 * results/baseline-lz4.md 同款；本机 CLOCK_MONOTONIC 在 vDSO 路径下
 * 有读值异常，勿改回）。
 *
 * 语义对齐 ZRAM 风格（同 baseline-lz4.md）：不可压块（输出 > 4KB 或
 * 失败）原样存储 + 4 字节长度头，sizes[i] 记负数表示 raw。这是
 * "原版 LZ4 + 系统兜底"的公平对照：原版本身无容器与不膨胀保障。
 *
 * Usage:  bench_stock <file>...
 * Build:  gcc -O3 -march=armv8.2-a -fno-strict-aliasing \
 *             -o bench_stock bench_stock.c stock/lz4.c -Istock
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lz4.h"

#define BLK 4096

static double cpu_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int g_iters = 3;

static uint8_t *read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) { perror(path); return NULL; }
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t *buf = malloc(sz ? (size_t)sz : 1);
  if (sz && fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return NULL; }
  fclose(f);
  *len = (size_t)sz;
  return buf;
}

typedef struct { uint64_t raw, comp; double c_sec, d_sec; size_t nraw; } Stats;

/* 压缩一遍：ZRAM 风格逐块，不可压块原样存储+4B 头。返回总压缩长。 */
static size_t compress_all(const uint8_t *src, size_t len, uint8_t *dst,
                           size_t dst_cap, int *sizes, size_t *nraw) {
  size_t nblk = (len + BLK - 1) / BLK;
  size_t total = 0;
  for (size_t i = 0; i < nblk; i++) {
    size_t off = i * BLK;
    size_t chunk = len - off < BLK ? len - off : BLK;
    int out = LZ4_compress_default((const char *)src + off, (char *)dst + total,
                                   (int)chunk, LZ4_compressBound((int)chunk));
    if (out <= 0 || (size_t)out > chunk) {
      memcpy(dst + total + 4, src + off, chunk);   /* +4：跳过长度头 */
      total += chunk + 4;
      sizes[i] = -(int)chunk;   /* 负数 = 原样存储 */
      if (nraw) (*nraw)++;
    } else {
      total += (size_t)out;
      sizes[i] = out;
    }
    if (total > dst_cap) { fprintf(stderr, "stock: dst overflow\n"); exit(1); }
  }
  return total;
}

/* 解压一遍并逐块校验。 */
static void decompress_all(const uint8_t *src, size_t len, const int *sizes,
                           uint8_t *out) {
  size_t nblk = (len + BLK - 1) / BLK;
  size_t off = 0;
  for (size_t i = 0; i < nblk; i++) {
    size_t blen = i * BLK + BLK <= len ? BLK : len - i * BLK;
    if (sizes[i] < 0) {
      memcpy(out + i * BLK, src + off + 4, blen);   /* 4B 头后是原样数据 */
      off += blen + 4;
    } else {
      int r = LZ4_decompress_safe((const char *)src + off, (char *)out + i * BLK,
                                  sizes[i], (int)blen);
      if (r != (int)blen) { fprintf(stderr, "stock: verify fail blk=%zu\n", i); exit(1); }
      off += (size_t)sizes[i];
    }
  }
}

static void bench_buf(const char *name, const uint8_t *data, size_t len, Stats *st) {
  size_t nblk = (len + BLK - 1) / BLK;
  size_t dst_cap = len + nblk * 8 + 64;
  uint8_t *comp = malloc(dst_cap);
  uint8_t *dec = malloc(len ? len : 1);
  int *sizes = malloc(nblk * sizeof(int));
  size_t nraw = 0;
  size_t cs = compress_all(data, len, comp, dst_cap, sizes, &nraw);
  decompress_all(comp, len, sizes, dec);
  if (len && memcmp(data, dec, len)) { fprintf(stderr, "bench: verify FAILED for %s\n", name); exit(1); }

  double t0 = cpu_sec();
  for (int it = 0; it < g_iters; it++)
    compress_all(data, len, comp, dst_cap, sizes, NULL);
  double t1 = cpu_sec();
  for (int it = 0; it < g_iters; it++)
    decompress_all(comp, len, sizes, dec);
  double t2 = cpu_sec();

  double gb = (double)len / 1e9;
  printf("%-12s raw=%10zu comp=%10zu ratio=%.3f  c=%7.3f GB/s  d=%7.3f GB/s",
         name, len, cs, len ? (double)len / (double)cs : 0.0,
         gb * g_iters / (t1 - t0), gb * g_iters / (t2 - t1));
  if (nraw) printf("  [raw块 %zu/%zu]", nraw, nblk);
  printf("\n");
  st->raw += len; st->comp += cs;
  st->c_sec += t1 - t0; st->d_sec += t2 - t1;
  st->nraw += nraw;
  free(comp); free(dec); free(sizes);
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s <file>...\n", argv[0]); return 2; }
  Stats st = {0};
  for (int i = 1; i < argc; i++) {
    size_t n;
    uint8_t *d = read_file(argv[i], &n);
    if (!d) return 1;
    bench_buf(argv[i], d, n, &st);
    free(d);
  }
  if (st.raw)
    printf("TOTAL raw=%" PRIu64 " comp=%" PRIu64 " ratio=%.3f  c=%.3f GB/s  d=%.3f GB/s%s\n",
           st.raw, st.comp, (double)st.raw / (double)st.comp,
           ((double)st.raw / 1e9) * g_iters / st.c_sec,
           ((double)st.raw / 1e9) * g_iters / st.d_sec,
           st.nraw ? "  [有raw块]" : "");
  return 0;
}
