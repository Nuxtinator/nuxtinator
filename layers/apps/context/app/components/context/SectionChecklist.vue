<script setup lang="ts">
// Checklist of template sections. Controlled: the parent owns `selected` and
// applies each `toggle`, so a parent that confirms before removing can leave
// the box unchanged when the user cancels.
interface ChecklistSection {
  key: string
  title: string
  description: string
}

const props = withDefaults(defineProps<{
  sections: readonly ChecklistSection[]
  selected: Set<string>
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{ toggle: [key: string, next: boolean] }>()

function toggle(key: string, next: boolean) {
  if (props.disabled) return
  emit('toggle', key, next)
}

function setAll(next: boolean) {
  for (const s of props.sections) {
    if (props.selected.has(s.key) !== next) toggle(s.key, next)
  }
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between text-xs text-(--ui-text-muted)">
      <span>{{ selected.size }} of {{ sections.length }} selected</span>
      <span class="flex gap-2">
        <UButton variant="link" size="xs" :disabled="disabled" @click="setAll(true)">
          Select all
        </UButton>
        <UButton variant="link" size="xs" :disabled="disabled" @click="setAll(false)">
          Select none
        </UButton>
      </span>
    </div>
    <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
      <li
        v-for="s in sections"
        :key="s.key"
        class="flex items-start gap-3 p-3"
        :class="disabled ? 'opacity-60' : 'cursor-pointer hover:bg-(--ui-bg-elevated)'"
        @click="toggle(s.key, !selected.has(s.key))"
      >
        <UCheckbox
          :model-value="selected.has(s.key)"
          :disabled="disabled"
          class="mt-0.5"
          @update:model-value="v => toggle(s.key, v === true)"
          @click.stop
        />
        <div class="min-w-0">
          <div class="text-sm font-medium">
            {{ s.title }}
          </div>
          <div v-if="s.description" class="text-xs text-(--ui-text-muted)">
            {{ s.description }}
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
