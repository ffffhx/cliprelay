# Compile-time Error Prone annotation references a JDK compiler enum absent on Android.
# It is carried by AndroidX test dependencies and is never loaded by the test runner.
-dontwarn javax.lang.model.element.Modifier
