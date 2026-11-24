<script setup>
/**
 * ProfileLoader.vue — Application Profile Loader.
 *
 * The ONLY component that reads the profile-config prop. Parses the JSON,
 * resolves the profile name, dynamically loads the matching Vue file from
 * src/app-profiles/*.vue. All configuration flows through provide/inject so
 * profile components and composables stay prop-free at the element boundary.
 *
 * Example:
 *   <feedback-web-component profile-config='{
 *     "profile": "chat-bubble",
 *     "instanceId": "fb-1",
 *     "projectId": "uuid-here",
 *     "apiBase": "https://kanban.example.com",
 *     "enabled": true,
 *     "showByDefault": true
 *   }'></feedback-web-component>
 *
 * `showByDefault` (default true) controls visibility for end users:
 *   - true:  the widget is shown to everyone.
 *   - false: the widget is hidden until the host page is visited with
 *            `?feedback=true` in the URL. That visit persists the opt-in to
 *            localStorage (key `show-feedback-widget`) so subsequent visits
 *            keep showing the widget without the param.
 *
 * `mode` ('testing' | 'standard', optional) sets how the widget presents
 * itself on this site, over the project's Testing mode switch. Left out, the
 * widget follows the project.
 */

import { computed, provide, defineAsyncComponent } from 'vue'

const OPT_IN_KEY = 'show-feedback-widget'

// The `?feedback=true` param is consumed at bundle load (see entry.js), which
// runs before host-framework hydration can replace the URL. By the time this
// component mounts, the flag is already in localStorage if the visitor opted
// in — so we only need to read it here.
function readStoredOptIn() {
  try {
    return localStorage.getItem(OPT_IN_KEY) === 'true'
  } catch {
    return false
  }
}

const optedIn = readStoredOptIn()

const props = defineProps({
  profileConfig: { type: String, default: '' }
})

const config = computed(() => {
  if (!props.profileConfig) return null
  try {
    return JSON.parse(props.profileConfig)
  } catch (e) {
    console.error('[feedback-web-component] Invalid profile-config JSON:', props.profileConfig)
    return null
  }
})

const profileName = computed(() => config.value?.profile || 'chat-bubble')
const projectId = computed(() => config.value?.projectId || '')
const apiBase = computed(() => config.value?.apiBase || '')
const enabled = computed(() => {
  const v = config.value?.enabled
  const baseEnabled = v === undefined ? true : Boolean(v)
  if (!baseEnabled) return false
  if (config.value?.showByDefault === false && !optedIn) return false
  return true
})
const instanceId = computed(() =>
  config.value?.instanceId || ('fb-' + Math.random().toString(36).slice(2, 9))
)
const embedMode = computed(() => {
  const m = config.value?.mode
  return m === 'testing' || m === 'standard' ? m : null
})

const profileModules = import.meta.glob('./app-profiles/*.vue')

const ProfileComponent = computed(() => {
  if (!config.value) return null
  const key = `./app-profiles/${profileName.value}.vue`
  if (!profileModules[key]) {
    console.error(
      `[feedback-web-component] Profile not found: "${profileName.value}". Available:`,
      Object.keys(profileModules)
    )
    return null
  }
  return defineAsyncComponent(profileModules[key])
})

// Expose parsed config to all descendants via inject()
provide('projectId', projectId)
provide('apiBase', apiBase)
provide('enabled', enabled)
provide('instanceId', instanceId)
provide('embedMode', embedMode)
provide('profileConfig', config)
</script>

<template>
  <div v-if="config && enabled" class="fw-loader">
    <div v-if="!ProfileComponent" class="fw-loader-error">
      <p>⚠️ feedback-web-component: profile <strong>"{{ profileName }}"</strong> not found.</p>
    </div>
    <component :is="ProfileComponent" v-else />
  </div>
  <div v-else-if="!config" class="fw-loader-error">
    <p>⚠️ feedback-web-component: missing or invalid <code>profile-config</code> prop.</p>
    <p>Example:</p>
    <pre>profile-config='{"profile":"chat-bubble","projectId":"...","apiBase":"https://..."}'</pre>
  </div>
</template>

<style scoped>
.fw-loader {
  width: 100%;
  height: 100%;
}
.fw-loader-error {
  padding: 10px 12px;
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  color: #78350f;
  max-width: 360px;
}
.fw-loader-error pre {
  background: rgba(0, 0, 0, 0.05);
  padding: 6px 8px;
  border-radius: 4px;
  margin: 6px 0 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
