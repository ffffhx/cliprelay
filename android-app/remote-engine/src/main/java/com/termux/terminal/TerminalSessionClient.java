package com.termux.terminal;
/** ClipRelay adaptation of the upstream client interface: no local TerminalSession or JNI. */
public interface TerminalSessionClient {
    default void onTerminalCursorStateChange(boolean state) {}
    default Integer getTerminalCursorStyle() { return null; }
    // Never log remote terminal content, even malformed escape sequences.
    default void logError(String tag, String message) {}
    default void logWarn(String tag, String message) {}
    default void logInfo(String tag, String message) {}
    default void logDebug(String tag, String message) {}
    default void logVerbose(String tag, String message) {}
}
