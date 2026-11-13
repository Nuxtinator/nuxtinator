<template>
  <div class="min-h-screen flex flex-col bg-(--ui-bg)">
    <SignedOutHeader />
    <!-- Anchored from the top, so the card's title stays put while its content grows or the view changes. -->
    <main class="flex-1 flex items-start justify-center px-4 pt-[clamp(2.5rem,14vh,10rem)] pb-12">
      <div class="w-full max-w-md">
        <slot />
      </div>
    </main>
  </div>
</template>
