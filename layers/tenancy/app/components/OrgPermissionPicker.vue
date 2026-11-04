<script setup lang="ts">
// Permission checklist for custom roles: one section per app (grouped by
// permission prefix), a checkbox per permission, and a select-all per section.

export interface PermissionGroup {
  id: string
  title: string
  icon?: string
}
export interface PermissionItem {
  perm: string
  group: string
  title: string
  description: string
}

const props = defineProps<{
  groups: PermissionGroup[]
  permissions: PermissionItem[]
  disabled?: boolean
}>()

const selected = defineModel<Set<string>>({ required: true })

const sections = computed(() => props.groups
  .map(g => ({ ...g, perms: props.permissions.filter(p => p.group === g.id) }))
  .filter(g => g.perms.length > 0))

const countIn = (perms: PermissionItem[]) => perms.filter(p => selected.value.has(p.perm)).length

const groupState = (perms: PermissionItem[]): boolean | 'indeterminate' => {
  const n = countIn(perms)
  if (n === 0) return false
  return n === perms.length ? true : 'indeterminate'
}

const toggle = (perm: string, on: boolean) => {
  const next = new Set(selected.value)
  if (on) next.add(perm)
  else next.delete(perm)
  selected.value = next
}

const toggleGroup = (perms: PermissionItem[]) => {
  const next = new Set(selected.value)
  const allOn = countIn(perms) === perms.length
  for (const p of perms) {
    if (allOn) next.delete(p.perm)
    else next.add(p.perm)
  }
  selected.value = next
}
</script>

<template>
  <div class="space-y-4">
    <section
      v-for="g in sections"
      :key="g.id"
      class="border border-(--ui-border) rounded-md"
    >
      <header class="flex items-center justify-between gap-3 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg-elevated)/50">
        <div class="flex items-center gap-2 min-w-0">
          <AppIcon
            :name="g.icon"
            class="size-5 shrink-0 text-sm"
          />
          <span class="font-medium truncate">{{ g.title }}</span>
          <span class="text-xs text-(--ui-text-muted)">
            {{ countIn(g.perms) }} / {{ g.perms.length }}
          </span>
        </div>
        <UCheckbox
          :model-value="groupState(g.perms)"
          :disabled="disabled"
          label="All"
          @update:model-value="toggleGroup(g.perms)"
        />
      </header>
      <div class="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2">
        <UCheckbox
          v-for="p in g.perms"
          :key="p.perm"
          :model-value="selected.has(p.perm)"
          :disabled="disabled"
          :label="p.title"
          :description="p.description"
          :title="p.perm"
          @update:model-value="(v: boolean | 'indeterminate') => toggle(p.perm, v === true)"
        />
      </div>
    </section>
  </div>
</template>
