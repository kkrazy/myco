/*
 * lz4fast_mt.c — 2-thread SMT variant of the MC4K codec: alternating
 * 4KB blocks split across two PERSISTENT worker threads pinned to the
 * two SMT siblings of one physical Kunpeng 920 core (cpu0+cpu1 must be
 * sibling vCPUs; pass -1 to let the scheduler decide).
 *
 * Container format and per-block no-expansion contract identical to
 * lz4fast.c; the output is a valid MC4K stream for myco_decompress.
 *
 * Compress: workers compress their strided blocks into a REUSED
 * worst-case scratch (2+4096+64 per block), the caller compacts into
 * the container layout (one sequential memcpy of the compressed size).
 * Decompress: one sequential walk precomputes per-block header
 * pointers, then the two workers decode their strided blocks straight
 * to the final output (blocks are independent; offsets are b*4096).
 *
 * Workers are created once (lazy, on first use) and parked on a
 * condition variable between calls — thread create/join per call
 * measurably ate the SMT gain at per-file granularity.
 */
#define _GNU_SOURCE
#include "myco_lz4.h"
#define LZ4_STATIC_LINKING_ONLY 1
#include "lz4.h"

#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define LZ4FAST_ACCEL 2
#define NTHREADS 2
/* LZ4_compressBound(4096) ≈ 4128 > 4096: the kernel may write up to
 * bound bytes even when we then discard the result (cs >= chunk →
 * store raw), so the scratch slot must hold the full bound. */
#define SLOT (2 + MYCO_BLOCK_SIZE + 64)

static void pin(int cpu) {
  if (cpu < 0) return;
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(cpu, &set);
  pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
}

/* ---- persistent worker pool ----
 * Idle workers park on a condvar. A spin-wait pool was tried and
 * REVERTED: idle spinners burn the sibling SMT slot AND pollute
 * CLOCK_PROCESS_CPUTIME_ID-based accounting (they count against the
 * process's CPU budget even while the main thread works), measurably
 * halving unrelated stock-path throughput in the same process. */

typedef enum { WS_IDLE, WS_RUN, WS_QUIT } WState;

typedef struct {
  pthread_t th;
  pthread_mutex_t mu;
  pthread_cond_t cv;
  WState state;
  void *(*fn)(void *);
  void *arg;
} Worker;

static Worker g_workers[NTHREADS - 1]; /* thread 0 runs inline */
static int g_workers_started = 0;

static void *worker_main(void *arg) {
  Worker *w = (Worker *)arg;
  for (;;) {
    pthread_mutex_lock(&w->mu);
    while (w->state == WS_IDLE)
      pthread_cond_wait(&w->cv, &w->mu);
    int quit = (w->state == WS_QUIT);
    void *(*fn)(void *) = w->fn;
    void *farg = w->arg;
    pthread_mutex_unlock(&w->mu);
    if (quit) break;
    fn(farg);
    pthread_mutex_lock(&w->mu);
    w->state = WS_IDLE;
    pthread_cond_broadcast(&w->cv);
    pthread_mutex_unlock(&w->mu);
  }
  return NULL;
}

/* Run fn(arg) on worker slot t (1..NTHREADS-1); returns after all done. */
static void pool_run(void *(*fns[])(void *), void **args, int n) {
  if (!g_workers_started) {
    for (int t = 1; t < NTHREADS; t++) {
      Worker *w = &g_workers[t - 1];
      pthread_mutex_init(&w->mu, NULL);
      pthread_cond_init(&w->cv, NULL);
      w->state = WS_IDLE;
      pthread_create(&w->th, NULL, worker_main, w);
    }
    g_workers_started = 1;
  }
  for (int t = 1; t < NTHREADS; t++) {
    Worker *w = &g_workers[t - 1];
    pthread_mutex_lock(&w->mu);
    w->fn = fns[t];
    w->arg = args[t];
    w->state = WS_RUN;
    pthread_cond_broadcast(&w->cv);
    pthread_mutex_unlock(&w->mu);
  }
  fns[0](args[0]); /* caller thread is worker 0 */
  for (int t = 1; t < NTHREADS; t++) {
    Worker *w = &g_workers[t - 1];
    pthread_mutex_lock(&w->mu);
    while (w->state == WS_RUN)
      pthread_cond_wait(&w->cv, &w->mu);
    pthread_mutex_unlock(&w->mu);
  }
}

/* ---- compress ---- */

typedef struct {
  const uint8_t *in;
  uint8_t *scratch;
  uint8_t *dst;
  size_t cap;
  size_t raw_len;
  size_t out_bytes; /* thread 0: bytes from dst start; thread 1: from dst end */
  int cpu;
  int idx;
} CtxC;

/* Parity striping: thread t compresses blocks t, t+2, ... into fixed
 * worst-case scratch slots; a single sequential compact pass then
 * assembles the container. (A "both ends fill + one memmove" scheme
 * with contiguous-range striping was tried to halve the compact copy
 * traffic — measured NO gain: the per-block slot write dominates, not
 * the final copy. Full compact keeps block order trivially correct.) */
static void *cworker(void *arg) {
  CtxC *c = (CtxC *)arg;
  pin(c->cpu);
  LZ4_stream_t stream;
  LZ4_initStream(&stream, sizeof(stream));
  int accel = LZ4FAST_ACCEL;
  size_t nblk = (c->raw_len + MYCO_BLOCK_SIZE - 1) / MYCO_BLOCK_SIZE;
  for (size_t b = (size_t)c->idx; b < nblk; b += NTHREADS) {
    size_t off = b * MYCO_BLOCK_SIZE;
    size_t chunk = c->raw_len - off < MYCO_BLOCK_SIZE ? c->raw_len - off : MYCO_BLOCK_SIZE;
    int bound = LZ4_compressBound((int)chunk);
    uint8_t *slot = c->scratch + b * SLOT;
    int cs = LZ4_compress_fast_extState_fastReset(
        &stream, (const char *)(c->in + off), (char *)(slot + 2),
        (int)chunk, bound, accel);
    uint16_t s;
    if (cs > 0 && (size_t)cs < chunk) {
      s = (uint16_t)cs;
      memcpy(slot, &s, 2);
    } else {
      s = 0;
      memcpy(slot, &s, 2);
      memcpy(slot + 2, c->in + off, chunk);
    }
    if (cs > 0 && (size_t)cs < chunk) {
      double r = (double)cs / (double)chunk;
      accel = (r > 0.95) ? LZ4FAST_ACCEL + 2 : (r < 0.20) ? 1 : LZ4FAST_ACCEL;
    } else {
      accel = LZ4FAST_ACCEL + 2;
    }
  }
  return NULL;
}

static uint8_t *g_scratch = NULL;
static size_t g_scratch_cap = 0;

size_t myco_compress_mt2(const void *src, size_t n, void *dst, size_t cap,
                         int cpu0, int cpu1) {
  if (cap < myco_compress_bound(n)) return 0;
  size_t nblk = (n + MYCO_BLOCK_SIZE - 1) / MYCO_BLOCK_SIZE;
  if (nblk * SLOT > g_scratch_cap) {
    free(g_scratch);
    g_scratch = malloc(nblk * SLOT);
    if (!g_scratch) { g_scratch_cap = 0; return 0; }
    g_scratch_cap = nblk * SLOT;
  }
  uint8_t *scratch = g_scratch;

  CtxC ctx[NTHREADS];
  void *(*fns[NTHREADS])(void *);
  void *args[NTHREADS];
  for (int t = 0; t < NTHREADS; t++) {
    ctx[t].in = (const uint8_t *)src;
    ctx[t].scratch = scratch;
    ctx[t].raw_len = n;
    ctx[t].cpu = t == 0 ? cpu0 : cpu1;
    ctx[t].idx = t;
    fns[t] = cworker;
    args[t] = &ctx[t];
  }
  pool_run(fns, args, NTHREADS);

  uint8_t *out = (uint8_t *)dst;
  memcpy(out, MYCO_MAGIC, 4);
  uint64_t raw = (uint64_t)n;
  memcpy(out + 4, &raw, 8);
  uint8_t *op = out + MYCO_HEADER_SIZE;
  for (size_t b = 0; b < nblk; b++) {
    const uint8_t *slot = scratch + b * SLOT;
    uint16_t s;
    memcpy(&s, slot, 2);
    size_t chunk = (n - b * MYCO_BLOCK_SIZE < MYCO_BLOCK_SIZE)
                       ? n - b * MYCO_BLOCK_SIZE : MYCO_BLOCK_SIZE;
    size_t payload = s ? s : chunk;
    memcpy(op, slot, 2 + payload);
    op += 2 + payload;
  }
  return (size_t)(op - out);
}

/* ---- decompress (pipelined) ----
 * The per-block header walk is a strict sequential dependency (every
 * block's position depends on all earlier sizes). Instead of paying it
 * as a serial prefix and then decoding in parallel, thread 0 (inline,
 * the caller) WALKS AND DECODES ALTERNATELY: it publishes tabs[b] with
 * a release store to a shared atomic cursor, decodes its own even
 * blocks as it goes; thread 1 spins briefly on the cursor to pick up
 * odd blocks just-in-time. The walk cost (3.2% of decode time) hides
 * behind thread 1's decoding. */

#include <stdatomic.h>

typedef struct {
  const uint8_t *in;        /* container base */
  size_t in_len;
  const uint8_t **tabs;     /* shared slot table (reused buffer) */
  atomic_size_t *cursor;    /* blocks walked so far (published) */
  uint8_t *out;
  size_t raw_len;
  int cpu;
  int idx;
  int rc;
} CtxD;

static void decode_block_at(CtxD *c, const uint8_t *ip, size_t b) {
  size_t off = b * MYCO_BLOCK_SIZE;
  size_t chunk = c->raw_len - off < MYCO_BLOCK_SIZE ? c->raw_len - off : MYCO_BLOCK_SIZE;
  uint16_t cs;
  memcpy(&cs, ip, 2);
  const uint8_t *pl = ip + 2;
  if (cs == 0) {
    memcpy(c->out + off, pl, chunk);
  } else {
    if ((size_t)cs >= chunk) { c->rc = 1; return; }
    int r = LZ4_decompress_safe((const char *)pl, (char *)(c->out + off),
                                (int)cs, (int)chunk);
    if (r != (int)chunk) { c->rc = 1; }
  }
}

/* Work split: parity 1:1 (leader takes even blocks, follower odd).
 * A 1:2 split (leader 1-in-3, follower the rest) was tried on the
 * theory the leader's header-walk tax called for rebalancing — it
 * measured WORSE (d 4.58 vs 4.95–4.99): on SMT siblings the follower
 * alone cannot absorb 2/3 of short-match-heavy text decoding, and the
 * leader's walk is cheap (3.2%) to begin with. */
#define LEADER_MOD 2

static void *dworker_leader(void *arg) {
  /* thread 0: walk headers + decode 1-in-LEADER_MOD blocks, interleaved */
  CtxD *c = (CtxD *)arg;
  pin(c->cpu);
  size_t nblk = (c->raw_len + MYCO_BLOCK_SIZE - 1) / MYCO_BLOCK_SIZE;
  const uint8_t *p = c->in + MYCO_HEADER_SIZE;
  const uint8_t *end = c->in + c->in_len;
  size_t chunk_last = c->raw_len - (nblk - 1) * MYCO_BLOCK_SIZE;
  for (size_t b = 0; b < nblk; b++) {
    if ((size_t)(end - p) < 2) { c->rc = 1; break; }
    c->tabs[b] = p;
    atomic_store_explicit(c->cursor, b + 1, memory_order_release);
    /* walk ahead cheaply: warm L1 for the follower's next few blocks
     * (it decodes b+1 while we decode b — its input is our future p) */
    if (b % 8 == 0 && end - p > 256)
      __builtin_prefetch(p + 2, 0, 1);
    if (b % LEADER_MOD == 0)
      decode_block_at(c, p, b);
    uint16_t cs;
    memcpy(&cs, p, 2);
    size_t chunk = (b + 1 == nblk) ? chunk_last : MYCO_BLOCK_SIZE;
    p += 2 + (cs ? cs : chunk);
  }
  atomic_store_explicit(c->cursor, nblk + 1, memory_order_release); /* EOF marker */
  return NULL;
}

static void *dworker_follower(void *arg) {
  /* thread 1: decode all blocks the leader doesn't take */
  CtxD *c = (CtxD *)arg;
  pin(c->cpu);
  size_t nblk = (c->raw_len + MYCO_BLOCK_SIZE - 1) / MYCO_BLOCK_SIZE;
  size_t next = 1;
  size_t cur;
  for (;;) {
    cur = atomic_load_explicit(c->cursor, memory_order_acquire);
    /* drain every published block BEFORE honoring the EOF marker:
     * the leader may finish the whole walk (and publish EOF) before
     * this thread wakes — the blocks it published are still owed. */
    while (next < cur && next < nblk) {
      if (next % LEADER_MOD != 0)
        decode_block_at(c, c->tabs[next], next);
      next++;
    }
    if (cur > nblk) break; /* EOF marker (nblk+1) */
    if (c->rc) break;
  }
  return NULL;
}

static const uint8_t **g_tabs = NULL;
static size_t g_tabs_cap = 0;
static atomic_size_t g_cursor;

size_t myco_decompress_mt2(const void *src, size_t n, void *dst, size_t cap,
                           int cpu0, int cpu1) {
  const uint8_t *ip = (const uint8_t *)src;
  if (n < MYCO_HEADER_SIZE || memcmp(ip, MYCO_MAGIC, 4) != 0) return 0;
  uint64_t raw;
  memcpy(&raw, ip + 4, 8);
  if (raw > cap) return 0;
  size_t nblk = ((size_t)raw + MYCO_BLOCK_SIZE - 1) / MYCO_BLOCK_SIZE;
  if (nblk > g_tabs_cap) {
    free(g_tabs);
    g_tabs = malloc(nblk * sizeof(*g_tabs));
    if (!g_tabs) { g_tabs_cap = 0; return 0; }
    g_tabs_cap = nblk;
  }

  CtxD ctx[NTHREADS];
  void *(*fns[NTHREADS])(void *);
  void *args[NTHREADS];
  for (int t = 0; t < NTHREADS; t++) {
    ctx[t].in = ip;
    ctx[t].in_len = n;
    ctx[t].tabs = g_tabs;
    ctx[t].cursor = &g_cursor;
    ctx[t].out = (uint8_t *)dst;
    ctx[t].raw_len = (size_t)raw;
    ctx[t].cpu = t == 0 ? cpu0 : cpu1;
    ctx[t].idx = t;
    ctx[t].rc = 0;
    fns[t] = t == 0 ? dworker_leader : dworker_follower;
    args[t] = &ctx[t];
  }
  atomic_store_explicit(&g_cursor, 0, memory_order_relaxed);
  pool_run(fns, args, NTHREADS);
  int bad = 0;
  for (int t = 0; t < NTHREADS; t++) bad |= ctx[t].rc;
  return bad ? 0 : (size_t)raw;
}
