/*
 * bench_mt.c — bench the 2-thread SMT codec (lz4fast_mt.c) the same way
 * bench.c benches the single-thread one: per-file verify + 3-iter CPU-time
 * throughput + per-block expansion check, plus a fuzz roundtrip.
 */
#include "myco_lz4.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

size_t myco_compress_mt2(const void *src, size_t n, void *dst, size_t cap,
                         int cpu0, int cpu1);
size_t myco_decompress_mt2(const void *src, size_t n, void *dst, size_t cap,
                           int cpu0, int cpu1);

static double now_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static int g_iters = 3;
static int g_cpu0 = -1, g_cpu1 = -1;

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

static uint64_t xorshift64(uint64_t *s) {
  uint64_t x = *s;
  x ^= x << 13; x ^= x >> 7; x ^= x << 17;
  *s = x;
  return x;
}

static int selftest(void) {
  uint64_t seed = 0x12345678ABCDEFULL;
  int rc = 0;
  static const size_t edge_sizes[] = {0, 1, 2, 31, 32, 100, 4095, 4096, 4097, 8192, 20000};
  uint8_t *src = malloc(65536);
  uint8_t *comp = malloc(myco_compress_bound(65536));
  uint8_t *dec = malloc(65536 + 64);
  uint8_t *src2 = malloc(30000);
  uint8_t *comp2 = malloc(myco_compress_bound(30000));
  uint8_t *dec2 = malloc(30000 + 64);
  for (size_t ei = 0; ei < sizeof(edge_sizes) / sizeof(edge_sizes[0]); ei++) {
    size_t n = edge_sizes[ei];
    for (int mode = 0; mode < 3; mode++) {
      for (size_t i = 0; i < n; i++) {
        if (mode == 0) src[i] = (uint8_t)(i & 0xFF);
        else if (mode == 1) src[i] = (uint8_t)(xorshift64(&seed) & 3 ? 0 : xorshift64(&seed));
        else src[i] = (uint8_t)xorshift64(&seed);
      }
      size_t cs = myco_compress_mt2(src, n, comp, myco_compress_bound(n), g_cpu0, g_cpu1);
      if (cs == 0) { fprintf(stderr, "selftest: compress failed n=%zu mode=%d\n", n, mode); rc = 1; continue; }
      memset(dec, 0xAA, n + 8);
      size_t ds = myco_decompress_mt2(comp, cs, dec, n + 8, g_cpu0, g_cpu1);
      if (ds != n) { fprintf(stderr, "selftest: decomp size n=%zu got=%zu\n", n, ds); rc = 1; continue; }
      if (n && memcmp(src, dec, n) != 0) { fprintf(stderr, "selftest: MISMATCH n=%zu mode=%d\n", n, mode); rc = 1; }
    }
  }
  /* interleaved mt-roundtrip stress: exercises pool reuse across many
   * calls (the persistent workers keep state between calls) */
  for (int iter = 0; iter < 500; iter++) {
    size_t n = (size_t)(xorshift64(&seed) % 30000);
    for (size_t i = 0; i < n; i++) src2[i] = (uint8_t)(xorshift64(&seed) >> 33);
    size_t cs = myco_compress_mt2(src2, n, comp2, myco_compress_bound(n), g_cpu0, g_cpu1);
    size_t ds = myco_decompress_mt2(comp2, cs, dec2, n + 8, g_cpu0, g_cpu1);
    if (ds != n || (n && memcmp(src2, dec2, n))) {
      fprintf(stderr, "selftest: mt-stress FAIL n=%zu\n", n);
      rc = 1;
      break;
    }
  }
  for (int iter = 0; iter < 10000; iter++) {
    size_t n = (size_t)(xorshift64(&seed) % 3000);
    for (size_t i = 0; i < n; i++) src[i] = (uint8_t)(xorshift64(&seed) >> 40);
    size_t cs = myco_compress_mt2(src, n, comp, myco_compress_bound(n), g_cpu0, g_cpu1);
    size_t ds = myco_decompress_mt2(comp, cs, dec, n + 8, g_cpu0, g_cpu1);
    if (ds != n || (n && memcmp(src, dec, n))) {
      fprintf(stderr, "selftest: fuzz FAIL n=%zu\n", n);
      rc = 1;
      break;
    }
  }
  free(src); free(comp); free(dec);
  free(src2); free(comp2); free(dec2);
  if (rc == 0) printf("selftest-mt: OK\n");
  return rc;
}

typedef struct { uint64_t raw, comp; double c_sec, d_sec; } Stats;

static void bench_buf(const char *name, const uint8_t *data, size_t len, Stats *st) {
  size_t bound = myco_compress_bound(len);
  uint8_t *comp = malloc(bound ? bound : 1);
  uint8_t *dec = malloc(len ? len : 1);
  size_t cs = myco_compress_mt2(data, len, comp, bound, g_cpu0, g_cpu1);
  size_t ds = myco_decompress_mt2(comp, cs, dec, len, g_cpu0, g_cpu1);
  if (cs == 0 || ds != len || (len && memcmp(data, dec, len))) {
    fprintf(stderr, "bench: verify FAILED for %s\n", name);
    exit(1);
  }
  double t0 = now_sec();
  for (int it = 0; it < g_iters; it++)
    cs = myco_compress_mt2(data, len, comp, bound, g_cpu0, g_cpu1);
  double t1 = now_sec();
  for (int it = 0; it < g_iters; it++)
    ds = myco_decompress_mt2(comp, cs, dec, len, g_cpu0, g_cpu1);
  double t2 = now_sec();
  (void)ds;
  /* per-block expansion check */
  size_t left = len;
  const uint8_t *ip = comp + MYCO_HEADER_SIZE;
  while (left > 0) {
    size_t chunk = left < MYCO_BLOCK_SIZE ? left : MYCO_BLOCK_SIZE;
    uint16_t s;
    memcpy(&s, ip, 2);
    if (s >= chunk) { fprintf(stderr, "bench: block expansion in %s\n", name); exit(1); }
    ip += 2 + (s ? s : chunk);
    left -= chunk;
  }
  double gb = (double)len / 1e9;
  printf("%-12s raw=%10zu comp=%10zu ratio=%.3f  c=%7.3f GB/s  d=%7.3f GB/s\n",
         name, len, cs, len ? (double)len / (double)cs : 0.0,
         gb * g_iters / (t1 - t0), gb * g_iters / (t2 - t1));
  st->raw += len; st->comp += cs;
  st->c_sec += t1 - t0; st->d_sec += t2 - t1;
  free(comp); free(dec);
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s selftest|bench [--cpus A,B] <file>...\n", argv[0]); return 2; }
  int argi = 2;
  if (argc > 3 && !strcmp(argv[argi], "--cpus")) {
    sscanf(argv[argi + 1], "%d,%d", &g_cpu0, &g_cpu1);
    argi += 2;
  }
  if (!strcmp(argv[1], "selftest")) return selftest();
  if (strcmp(argv[1], "bench") != 0) { fprintf(stderr, "unknown cmd\n"); return 2; }
  Stats st = {0};
  for (int i = argi; i < argc; i++) {
    size_t n;
    uint8_t *d = read_file(argv[i], &n);
    if (!d) return 1;
    bench_buf(argv[i], d, n, &st);
    free(d);
  }
  if (st.raw)
    printf("TOTAL raw=%" PRIu64 " comp=%" PRIu64 " ratio=%.3f  c=%.3f GB/s  d=%.3f GB/s\n",
           st.raw, st.comp, (double)st.raw / (double)st.comp,
           ((double)st.raw / 1e9) * g_iters / st.c_sec,
           ((double)st.raw / 1e9) * g_iters / st.d_sec);
  return 0;
}
