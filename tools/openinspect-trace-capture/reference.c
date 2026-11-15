/* Independent in-program clock/CPU reference. Compile only for acceptance tests. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>

static uint64_t monotonic_ns(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) exit(2);
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    uint64_t amount = strtoull(argv[2], NULL, 10);
    uint64_t begin = monotonic_ns();
    volatile uint64_t checksum = 1;
    if (!strcmp(argv[1], "sleep-ns")) {
        struct timespec delay = {(time_t)(amount / UINT64_C(1000000000)), (long)(amount % UINT64_C(1000000000))};
        while (nanosleep(&delay, &delay) && errno == EINTR) {}
    } else if (!strcmp(argv[1], "work")) {
        for (uint64_t i = 0; i < amount; i++) {
            checksum ^= checksum << 13;
            checksum ^= checksum >> 7;
            checksum ^= checksum << 17;
        }
    } else return 2;
    uint64_t end = monotonic_ns();
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage)) return 2;
    uint64_t user_ns = (uint64_t)usage.ru_utime.tv_sec * UINT64_C(1000000000) + (uint64_t)usage.ru_utime.tv_usec * 1000;
    uint64_t system_ns = (uint64_t)usage.ru_stime.tv_sec * UINT64_C(1000000000) + (uint64_t)usage.ru_stime.tv_usec * 1000;
    printf("{\"start_ns\":\"%" PRIu64 "\",\"end_ns\":\"%" PRIu64 "\",\"user_cpu_ns\":\"%" PRIu64 "\",\"system_cpu_ns\":\"%" PRIu64 "\",\"checksum\":\"%" PRIu64 "\"}\n", begin, end, user_ns, system_ns, checksum);
    return 0;
}
