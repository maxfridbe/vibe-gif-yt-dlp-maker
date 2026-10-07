FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies, compilation tools, GTK, MinGW, OpenJDK
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    wget \
    unzip \
    git \
    pkg-config \
    libssl-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    mingw-w64 \
    openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# Set up Android SDK & NDK
ENV ANDROID_HOME=/opt/android-sdk
ENV NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

RUN mkdir -p $ANDROID_HOME/cmdline-tools && \
    curl -sS https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d $ANDROID_HOME/cmdline-tools && \
    mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses && \
    $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
    "platforms;android-34" \
    "build-tools;34.0.0" \
    "ndk;26.1.10909125"

# Install Rust & toolchain targets
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable && \
    rustup target add x86_64-unknown-linux-gnu && \
    rustup target add x86_64-pc-windows-gnu && \
    rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android && \
    cargo install tauri-cli --locked

WORKDIR /workspace

CMD ["/bin/bash", "/workspace/scripts/build-all-in-container.sh"]
