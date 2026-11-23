plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes the build number and the signing key through the environment (see .github/workflows/build.yml).
val buildNumber = (System.getenv("GEMSPACE_BUILD") ?: "1").toInt()
val keystorePath: String? = System.getenv("GEMSPACE_KEYSTORE")

android {
    namespace = "app.gemspace.allinone"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.gemspace.allinone"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("GEMSPACE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("GEMSPACE_KEY_ALIAS") ?: "gemspace"
                keyPassword = System.getenv("GEMSPACE_KEY_PASSWORD") ?: System.getenv("GEMSPACE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        // the WebView profile APIs are guarded by WebViewFeature checks at runtime
        checkReleaseBuilds = false
        abortOnError = false
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
}
