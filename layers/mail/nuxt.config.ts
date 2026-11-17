// @nuxtinator/mail is a framework-free package: the mail kernel (`./kernel`),
// the provider adapters (`./adapters`) and a fake provider for tests (`./test`).
// This file only lets layers.ts, the layer sync and the release tooling treat
// it like any other layer. Core registers the adapters and builds the kernel;
// nothing here touches core, which would make the dependency circular.
export default defineNuxtConfig({})
