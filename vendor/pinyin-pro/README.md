# Bundled pinyin-pro

This directory contains the self-contained CommonJS distribution of
[pinyin-pro](https://github.com/zh-lx/pinyin-pro), version **3.29.5**,
published at https://registry.npmjs.org/pinyin-pro/-/pinyin-pro-3.29.5.tgz.

- `index.js` is the unmodified published `dist/index.js` bundle, including its pronunciation data.
- `LICENSE` is the upstream MIT license and copyright notice.
- SHA-256 of `index.js`: `a488173470768ace074c3c4fffbb880e83523b3aa9598a8147c930e7f2d5c7dc`.

The bundle supports loading directly using a relative path. It has no
external runtime dependencies, installation step, native binaries or network
requests. Existing deployments can receive it through the normal code update
and hot reload without running npm.

To update the bundle, obtain the published package for the intended version,
copy `dist/index.js` and `LICENSE` unchanged, update this version and checksum,
and run the full test suite, including `test/bundled-pinyin.test.js`.
