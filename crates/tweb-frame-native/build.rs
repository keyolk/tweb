fn main() {
    // On macOS this links the addon with `-undefined dynamic_lookup`: the Node-API symbols are
    // resolved against the Electron binary that loads it, so no Node headers or import library
    // are needed at build time.
    napi_build::setup();
}
