package com.limelight.computers;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Probe routes together, allowing a short grace period for a preferred direct route. */
public final class ConnectionRouteSelector {
    private ConnectionRouteSelector() {}

    private static final class Result<T> {
        final int index;
        final T value;
        Result(int index, T value) { this.index = index; this.value = value; }
    }

    public static <T> T select(List<Callable<T>> probes, long preferenceMs) throws InterruptedException {
        return select(probes, preferenceMs, 15000);
    }

    public static <T> T select(List<Callable<T>> probes, long preferenceMs, long timeoutMs) throws InterruptedException {
        if (preferenceMs < 0 || timeoutMs <= 0 || timeoutMs > 120000)
            throw new IllegalArgumentException("Invalid route selection timeout");
        if (probes.isEmpty()) return null;
        final long expires = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        ExecutorService executor = Executors.newFixedThreadPool(probes.size(), runnable -> {
            Thread thread = new Thread(runnable, "ClipRelay route probe");
            thread.setDaemon(true);
            return thread;
        });
        ExecutorCompletionService<Result<T>> completed = new ExecutorCompletionService<>(executor);
        List<Future<Result<T>>> futures = new ArrayList<>();
        boolean[] done = new boolean[probes.size()];
        int bestIndex = probes.size();
        T best = null;
        long deadline = expires;
        try {
            for (int i = 0; i < probes.size(); i++) {
                final int index = i;
                futures.add(completed.submit(() -> {
                    try { return new Result<>(index, probes.get(index).call()); }
                    catch (Exception ignored) { return new Result<>(index, null); }
                }));
            }
            for (int remaining = probes.size(); remaining > 0; remaining--) {
                if (best != null) {
                    boolean preferredDone = true;
                    for (int i = 0; i < bestIndex; i++) preferredDone &= done[i];
                    if (preferredDone) return best;
                }
                Future<Result<T>> future = completed.poll(
                        Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (future == null) return best;
                Result<T> result;
                try { result = future.get(); }
                catch (java.util.concurrent.ExecutionException error) { throw new IllegalStateException(error.getCause()); }
                done[result.index] = true;
                if (result.value != null && result.index < bestIndex) {
                    if (best == null) deadline = Math.min(expires,
                            System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.min(preferenceMs, timeoutMs)));
                    best = result.value;
                    bestIndex = result.index;
                }
            }
            return best;
        } finally {
            for (Future<?> future : futures) future.cancel(true);
            executor.shutdownNow();
        }
    }
}
