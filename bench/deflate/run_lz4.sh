#!/bin/bash
# run_lz4.sh — 一键构建并运行 原版 LZ4 vs 改进版 v5-mt 对比基准
#
# 输出：两版的压缩率（ratio）/ 压缩速度（c GB/s）/ 解压速度（d GB/s）
#       与目标对照，同口径（4KB 逐块、绑核、3 次迭代）
#
# 用法：
#   ./run_lz4.sh [语料目录或文件...] [CPU对]
#   默认语料：./dataset（Silesia），默认 CPU 对自动探测同物理核线程
#
# 机器要求：aarch64（armv8.2-a）、gcc（支持 PGO/LTO）、SMT 机器
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/lz4_improve"
CORPUS="${1:-$HERE/dataset}"
CPU_PAIR="${2:-}"

# ---- 语料展开为文件列表（bench 只收文件，目录参数会让 PGO 训练失真）----
if [ -d "$CORPUS" ]; then
  mapfile -t FILES < <(find "$CORPUS" -type f | sort)
else
  FILES=("$CORPUS")
fi
if [ ${#FILES[@]} -eq 0 ]; then
  echo "error: no files under $CORPUS" >&2; exit 1
fi

# ---- 自动探测同物理核线程对（取第一对）----
# thread_siblings_list 可能是 "0-1" 或 "0,1" 两种格式
if [ -z "$CPU_PAIR" ]; then
  RAW=$(cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list 2>/dev/null)
  C0=$(echo "$RAW" | tr ',-' '  ' | awk '{print $1}')
  C1=$(echo "$RAW" | tr ',-' '  ' | awk '{print $2}')
  CPU_PAIR="${C0:-0} ${C1:-1}"
fi
C0="${CPU_PAIR%%[ ,]*}"
C1=$(echo "$CPU_PAIR" | awk '{print $NF}')

CFLAGS="-O3 -march=armv8.2-a -fno-strict-aliasing -Wno-format-truncation -flto"
KCFG="-DLZ4_SKIP_TRIGGER=3 -DLZ4_MEMORY_USAGE=13 -DLZ4_SEARCH_INIT_SHIFT=-14 -DLZ4_FORCE_BYU32_SMALL"
cd "$DIR"

# ---- 静默构建：原版对照（stock v1.10.1）与改进版 v5-mt，PGO+LTO 同待遇 ----
rm -f "$HERE"/lz4/bench_stock-*.gcda bench_mt-*.gcda
gcc $CFLAGS -fprofile-generate -o "$HERE/lz4/bench_stock" \
    "$HERE/lz4/bench_stock.c" "$HERE/lz4/lz4.c" -I"$HERE/lz4" 2>/dev/null
"$HERE/lz4/bench_stock" "${FILES[@]}" > /dev/null
gcc $CFLAGS -fprofile-use -o "$HERE/lz4/bench_stock" \
    "$HERE/lz4/bench_stock.c" "$HERE/lz4/lz4.c" -I"$HERE/lz4"

gcc $CFLAGS $KCFG -fprofile-generate -fprofile-update=atomic -lpthread \
    -o bench_mt bench_mt.c lz4fast_mt.c lz4fast.c lz4k/lz4.c -Ilz4k -I. 2>/dev/null
./bench_mt selftest > /dev/null
./bench_mt bench --cpus "$C0,$C1" "${FILES[@]}" > /dev/null   # 训练必须传文件列表
gcc $CFLAGS $KCFG -fprofile-use -lpthread \
    -o bench_mt bench_mt.c lz4fast_mt.c lz4fast.c lz4k/lz4.c -Ilz4k -I.

# ---- 正式测量：先原版，后改进版 ----
echo "==== 原版 LZ4（stock v1.10.1，4KB 逐块）===="
taskset -c "$C0" "$HERE/lz4/bench_stock" "${FILES[@]}"

echo
echo "==== 改进版 v5-mt（4KB 逐块）===="
taskset -c "$C0" ./bench_mt bench --cpus "$C0,$C1" "${FILES[@]}"

echo
echo "==== 目标对照（难题总结.md §4）===="
echo "目标: 压缩 >1 GB/s | 解压 >5 GB/s | ratio >= 1.6460 (LZ4 1.733 x 0.95) | 任意块不膨胀"
echo "判定看改进版 TOTAL 行"
