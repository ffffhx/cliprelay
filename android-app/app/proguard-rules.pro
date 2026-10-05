# ClipRelay does not use reflection-based serialization.

# gomobile's JNI bridge uses generated class and method names.
-keep class go.** { *; }
-keep class com.cliprelay.network.** { *; }
