/*
 * myco_lz4 — LZ4-class 4KB-block compressor for memory (ZRAM-style) use.
 *
 * Design targets (see ../难题总结.md):
 *   - every 4KB block is compressed INDEPENDENTLY (no cross-block state)
 *   - per-block payload never larger than the raw block ("no expansion":
 *     if compression does not shrink the block, the raw bytes are stored)
 *   - single-core compress > 1 GB/s, decompress > 5 GB/s on 2.6 GHz aarch64
 *   - ratio within 5% of stock LZ4 at the same 4KB block granularity
 *
 * Block payload bitstream is LZ4-sequence compatible:
 *   token | litlen-ext | literals | offset(2B LE) | matchlen-ext
 * so a compressed block (non-raw) is decodable by any stock LZ4 block
 * decoder given the block's raw size.
 *
 * Container format (little-endian):
 *   offset  0: magic  "MC4K" (4 bytes)
 *   offset  4: u64    raw size N
 *   offset 12: blocks — for each 4096-byte chunk of the input:
 *              u16 csize; if csize == 0 the raw chunk follows (chunk did
 *              not compress), else csize bytes of LZ4-sequence payload
 *              (1 <= csize < chunk size, guaranteed by the compressor).
 *
 * Self-contained C99. No dependencies beyond libc.
 */
#ifndef MYCO_LZ4_H
#define MYCO_LZ4_H

#include <stddef.h>
#include <stdint.h>

#define MYCO_BLOCK_SIZE 4096
#define MYCO_HEADER_SIZE 12
#define MYCO_MAGIC "MC4K"

#ifdef __cplusplus
extern "C" {
#endif

/* Worst-case container size for n input bytes (header + 2B/block + raw). */
size_t myco_compress_bound(size_t n);

/*
 * Compress n bytes from src into dst (multi-block container).
 * Returns the compressed size, or 0 if dst_cap < myco_compress_bound(n).
 * Never reads more than n bytes from src.
 */
size_t myco_compress(const void *src, size_t n, void *dst, size_t dst_cap);

/*
 * Decompress a container produced by myco_compress.
 * Returns the raw size, or 0 on error (bad magic/truncated/corrupt/too
 * small dst_cap). A 0-byte input compresses to a header-only container
 * which decompresses to 0 bytes (also returns 0).
 */
size_t myco_decompress(const void *src, size_t n, void *dst, size_t dst_cap);

/*
 * Compress ONE block (n <= 65520) with an independent hash table.
 * Returns the payload size in [1, cap], or 0 if the block does not
 * compress to <= cap bytes (caller should store the raw block).
 * Never reads past src+n.
 */
size_t myco_compress_block(const void *src, size_t n, void *dst, size_t cap);

/*
 * Decompress ONE LZ4-sequence block. Returns the number of raw bytes
 * produced (must equal the known block size), or 0 on corrupt input /
 * insufficient cap.
 */
size_t myco_decompress_block(const void *src, size_t n, void *dst, size_t cap);

/*
 * Fast block decoder (decode_neon.c): NEON-accelerated on aarch64,
 * bit-identical to myco_decompress_block. Same return contract.
 */
size_t myco_decompress_block_neon(const void *src, size_t n, void *dst, size_t cap);

#ifdef __cplusplus
}
#endif

#endif /* MYCO_LZ4_H */
