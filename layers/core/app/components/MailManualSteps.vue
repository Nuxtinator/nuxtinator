<script setup lang="ts">
// Steps to follow at the provider. A step that names a check shows that
// check's result from the last Check in place of its number. Each step's
// instructions open under its title.
import type { MailDnsRecord, MailManualStep, MailRoleCheck } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  steps: MailManualStep[]
  checks?: MailRoleCheck['checks']
  // The provider's DNS records, shown on the step that adds them
  records?: MailDnsRecord[]
}>(), { checks: () => [], records: () => [] })

const resultOf = (step: MailManualStep) => step.check ? props.checks.find(c => c.key === step.check) ?? null : null
const hasHow = (step: MailManualStep) => !!step.detail || !!step.values?.length || (step.check === 'provider-dns' && props.records.length > 0)

const opened = ref(new Set<number>())
function toggle(i: number) {
  const next = new Set(opened.value)
  if (!next.delete(i)) next.add(i)
  opened.value = next
}
</script>

<template>
  <ol class="space-y-3">
    <li
      v-for="(step, i) in steps"
      :key="i"
      class="flex gap-3"
    >
      <span
        v-if="resultOf(step)?.ok === true"
        class="flex items-center justify-center size-6 shrink-0"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-5 text-(--ui-success)"
          aria-label="Done"
        />
      </span>
      <span
        v-else-if="resultOf(step)?.ok === false"
        class="flex items-center justify-center size-6 shrink-0"
      >
        <UIcon
          name="i-lucide-circle-alert"
          class="size-5 text-(--ui-warning)"
          aria-label="Not done yet"
        />
      </span>
      <span
        v-else
        class="flex items-center justify-center size-6 shrink-0 rounded-full bg-(--ui-bg-elevated) text-xs font-medium"
      >
        {{ i + 1 }}
      </span>
      <div class="min-w-0 flex-1 space-y-1">
        <button
          v-if="hasHow(step)"
          type="button"
          class="flex items-center gap-1 text-left text-sm font-medium"
          :class="{ 'text-(--ui-text-muted)': resultOf(step)?.ok === true }"
          :aria-expanded="opened.has(i)"
          @click="toggle(i)"
        >
          {{ step.title }}
          <UIcon
            :name="opened.has(i) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="size-4 shrink-0 text-(--ui-text-dimmed)"
          />
        </button>
        <div
          v-else
          class="text-sm font-medium"
          :class="{ 'text-(--ui-text-muted)': resultOf(step)?.ok === true }"
        >
          {{ step.title }}
        </div>
        <p
          v-if="resultOf(step)?.detail && resultOf(step)?.ok !== true"
          class="text-sm text-(--ui-warning) break-words"
        >
          {{ resultOf(step)!.detail }}
        </p>
        <div
          v-if="opened.has(i)"
          class="space-y-1"
        >
          <p
            v-if="step.detail"
            class="text-sm text-(--ui-text-muted) break-words"
          >
            {{ step.detail }}
          </p>
          <MailCopyValue
            v-for="v in step.values ?? []"
            :key="v.label"
            :label="v.label"
            :value="v.value"
          />
          <MailDnsRecords
            v-if="step.check === 'provider-dns' && records.length"
            :records="records"
            :grouped="false"
          />
        </div>
      </div>
    </li>
  </ol>
</template>
