plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.autorush.portal"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.autorush.portal"
        minSdk = 26
        targetSdk = 35
        versionCode = 8
        versionName = "0.5.1"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }
    signingConfigs.getByName("debug") {
        storeFile = file("../../../artifacts/tools/debug.keystore")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // ZXing's published POM omits its runtime AndroidX permission helpers.
    implementation("androidx.core:core:1.15.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
