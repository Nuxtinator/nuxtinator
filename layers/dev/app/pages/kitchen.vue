<script setup lang="ts">
import { h, resolveComponent } from 'vue'

definePageMeta({
  middleware: 'auth'
})

// Radio group model
const radioValue = ref('1')

// Table data
const tableColumns = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name'
  },
  {
    id: 'email',
    accessorKey: 'email',
    header: 'Email',
    cell: ({ row }: any) => h('div', { class: 'lowercase' }, row.getValue('email'))
  },
  {
    id: 'role',
    accessorKey: 'role',
    header: 'Role'
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: any) => {
      const status = row.getValue('status')
      const color = status === 'Active' ? 'success' : status === 'Pending' ? 'warning' : 'error'
      return h(resolveComponent('UBadge'), { color, label: status })
    }
  }
]

const tableRows = [
  { name: 'John Doe', email: 'john@example.com', role: 'Admin', status: 'Active' },
  { name: 'Jane Smith', email: 'jane@example.com', role: 'User', status: 'Active' },
  { name: 'Bob Johnson', email: 'bob@example.com', role: 'User', status: 'Pending' },
  { name: 'Alice Williams', email: 'alice@example.com', role: 'Moderator', status: 'Inactive' }
]
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold mb-8">
      Kitchen Sink UI Showcase
    </h1>

    <!-- Typography Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Typography
      </h2>
      <UCard>
        <h1>Heading 1 - Main Title</h1>
        <h2>Heading 2 - Section Title</h2>
        <h3>Heading 3 - Subsection Title</h3>
        <h4>Heading 4 - Minor Heading</h4>
        <h5>Heading 5 - Small Heading</h5>
        <h6>Heading 6 - Smallest Heading</h6>
        <p>Regular paragraph text with <strong>bold text</strong>, <em>italic text</em>, <u>underlined text</u>, and <a href="#">a link</a>.</p>
        <p class="text-muted">
          Muted text for secondary information.
        </p>
        <blockquote>This is a blockquote. It's used for quotations or callouts.</blockquote>
        <code>inline-code-example</code>
      </UCard>
    </section>

    <!-- Buttons Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Buttons
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <UCard>
          <template #header>
            <h3>Primary Buttons</h3>
          </template>
          <div class="button-grid">
            <UButton>Default</UButton>
            <UButton size="xs">
              Extra Small
            </UButton>
            <UButton size="sm">
              Small
            </UButton>
            <UButton size="lg">
              Large
            </UButton>
            <UButton size="xl">
              Extra Large
            </UButton>
            <UButton disabled>
              Disabled
            </UButton>
            <UButton loading>
              Loading
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Button Colors</h3>
          </template>
          <div class="button-grid">
            <UButton color="primary">
              Primary
            </UButton>
            <UButton color="secondary">
              Secondary
            </UButton>
            <UButton color="success">
              Success
            </UButton>
            <UButton color="info">
              Info
            </UButton>
            <UButton color="warning">
              Warning
            </UButton>
            <UButton color="error">
              Error
            </UButton>
            <UButton color="neutral">
              Neutral
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Button Variants</h3>
          </template>
          <div class="button-grid">
            <UButton variant="solid">
              Solid
            </UButton>
            <UButton variant="outline">
              Outline
            </UButton>
            <UButton variant="soft">
              Soft
            </UButton>
            <UButton variant="subtle">
              Subtle
            </UButton>
            <UButton variant="ghost">
              Ghost
            </UButton>
            <UButton variant="link">
              Link
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Block Buttons</h3>
          </template>
          <div class="space-y-3">
            <UButton block>
              Block Button
            </UButton>
            <UButton
              block
              variant="outline"
            >
              Block Outline
            </UButton>
            <UButton
              block
              variant="soft"
            >
              Block Soft
            </UButton>
          </div>
        </UCard>
      </div>
    </section>

    <!-- Links Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Links
      </h2>
      <UCard>
        <div class="link-showcase">
          <ULink to="/">Home Link</ULink>
          <ULink to="/profile">Profile Link</ULink>
          <ULink
            to="/kitchen"
            inactive-class="text-muted"
          >Inactive Link</ULink>
          <ULink
            href="https://nuxt.com"
            external
            target="_blank"
          >External Link</ULink>
          <ULink
            raw
            to="#"
            class="text-error hover:underline"
          >Error Link</ULink>
          <ULink
            raw
            to="#"
            class="text-success hover:underline"
          >Success Link</ULink>
          <ULink
            raw
            to="#"
            class="text-warning hover:underline"
          >Warning Link</ULink>
        </div>
      </UCard>
    </section>

    <!-- Cards Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Cards
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <UCard>
          <template #header>
            <h3>Simple Card</h3>
          </template>
          <p>This is a simple card with a header and some content.</p>
        </UCard>

        <UCard>
          <template #header>
            <h3>Card with Footer</h3>
          </template>
          <p>This card has both a header and a footer.</p>
          <template #footer>
            <div class="card-footer">
              <UButton size="sm">
                Action
              </UButton>
              <UButton
                size="sm"
                variant="ghost"
              >
                Cancel
              </UButton>
            </div>
          </template>
        </UCard>

        <UCard>
          <h3>Card without Header</h3>
          <p>This card has no header slot, just content.</p>
        </UCard>

        <UCard>
          <template #header>
            <h3>Stats Card</h3>
          </template>
          <div class="stats">
            <div class="stat-item">
              <div class="stat-value">
                1,234
              </div>
              <div class="stat-label">
                Users
              </div>
            </div>
            <div class="stat-item">
              <div class="stat-value">
                567
              </div>
              <div class="stat-label">
                Posts
              </div>
            </div>
            <div class="stat-item">
              <div class="stat-value">
                89
              </div>
              <div class="stat-label">
                Comments
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </section>

    <!-- Forms Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Form Elements
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <UCard>
          <template #header>
            <h3>Text Inputs</h3>
          </template>
          <div class="form-group">
            <label>Default Input</label>
            <UInput placeholder="Enter text..." />
          </div>
          <div class="form-group">
            <label>Email Input</label>
            <UInput
              type="email"
              placeholder="email@example.com"
            />
          </div>
          <div class="form-group">
            <label>Disabled Input</label>
            <UInput
              disabled
              placeholder="Disabled"
            />
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Textarea & Select</h3>
          </template>
          <div class="form-group">
            <label>Textarea</label>
            <UTextarea
              placeholder="Enter long text..."
              :rows="3"
            />
          </div>
          <div class="form-group">
            <label>Select</label>
            <USelect
              :items="['Option 1', 'Option 2', 'Option 3']"
              placeholder="Select an option"
            />
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Checkboxes & Radio</h3>
          </template>
          <div class="form-group">
            <UCheckbox
              label="Checkbox Option 1"
              default-value
            />
            <UCheckbox label="Checkbox Option 2" />
            <UCheckbox
              label="Disabled Checkbox"
              disabled
            />
          </div>
          <div class="form-group">
            <URadioGroup
              v-model="radioValue"
              :items="[
                { label: 'Radio Option 1', value: '1' },
                { label: 'Radio Option 2', value: '2' }
              ]"
            />
          </div>
        </UCard>
      </div>
    </section>

    <!-- Alerts Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Alerts & Notifications
      </h2>
      <div class="space-y-3">
        <UAlert
          color="primary"
          variant="subtle"
          title="Info"
          description="This is an informational message."
          icon="i-lucide-info"
        />
        <UAlert
          color="success"
          variant="subtle"
          title="Success"
          description="Operation completed successfully!"
          icon="i-lucide-check-circle"
        />
        <UAlert
          color="warning"
          variant="subtle"
          title="Warning"
          description="Please check your input."
          icon="i-lucide-alert-triangle"
        />
        <UAlert
          color="error"
          variant="subtle"
          title="Error"
          description="Something went wrong."
          icon="i-lucide-x-circle"
        />
      </div>
    </section>

    <!-- Icons Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Icons (Lucide)
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <UCard>
          <template #header>
            <h3>Icon Buttons</h3>
          </template>
          <div class="button-grid">
            <UButton icon="i-lucide-plus">
              Add
            </UButton>
            <UButton
              icon="i-lucide-pencil"
              color="secondary"
            >
              Edit
            </UButton>
            <UButton
              icon="i-lucide-trash"
              color="error"
            >
              Delete
            </UButton>
            <UButton
              icon="i-lucide-download"
              variant="outline"
            >
              Download
            </UButton>
            <UButton
              icon="i-lucide-settings"
              variant="ghost"
            />
            <UButton
              icon="i-lucide-heart"
              variant="soft"
              color="error"
            />
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Input with Icons</h3>
          </template>
          <div class="space-y-3">
            <UInput
              icon="i-lucide-search"
              placeholder="Search..."
            />
            <UInput
              icon="i-lucide-mail"
              placeholder="Email address"
            />
            <UInput
              icon="i-lucide-lock"
              type="password"
              placeholder="Password"
            />
            <UInput
              icon="i-lucide-user"
              placeholder="Username"
            />
          </div>
        </UCard>

        <UCard class="md:col-span-2">
          <template #header>
            <h3>Common Icons</h3>
          </template>
          <div class="flex flex-wrap gap-4">
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-home"
                class="text-2xl"
              />
              <span class="text-xs text-muted">home</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-user"
                class="text-2xl"
              />
              <span class="text-xs text-muted">user</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-settings"
                class="text-2xl"
              />
              <span class="text-xs text-muted">settings</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-bell"
                class="text-2xl"
              />
              <span class="text-xs text-muted">bell</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-calendar"
                class="text-2xl"
              />
              <span class="text-xs text-muted">calendar</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-folder"
                class="text-2xl"
              />
              <span class="text-xs text-muted">folder</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-file"
                class="text-2xl"
              />
              <span class="text-xs text-muted">file</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-image"
                class="text-2xl"
              />
              <span class="text-xs text-muted">image</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-check"
                class="text-2xl"
              />
              <span class="text-xs text-muted">check</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-x"
                class="text-2xl"
              />
              <span class="text-xs text-muted">x</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-arrow-right"
                class="text-2xl"
              />
              <span class="text-xs text-muted">arrow-right</span>
            </div>
            <div class="flex flex-col items-center gap-1">
              <UIcon
                name="i-lucide-external-link"
                class="text-2xl"
              />
              <span class="text-xs text-muted">external-link</span>
            </div>
          </div>
        </UCard>
      </div>
    </section>

    <!-- Badges Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Badges & Tags
      </h2>
      <UCard>
        <div class="badge-showcase">
          <UBadge
            color="neutral"
            variant="solid"
            label="Default"
          />
          <UBadge
            color="primary"
            variant="solid"
            label="Primary"
          />
          <UBadge
            color="success"
            variant="solid"
            label="Success"
          />
          <UBadge
            color="warning"
            variant="solid"
            label="Warning"
          />
          <UBadge
            color="error"
            variant="solid"
            label="Error"
          />
          <UBadge
            color="info"
            variant="solid"
            label="Info"
          />
          <UBadge
            color="neutral"
            variant="outline"
            label="Outline"
          />
        </div>
      </UCard>
    </section>

    <!-- User avatars Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        User Avatars
      </h2>
      <UCard>
        <div class="flex flex-wrap gap-4">
          <div
            v-for="color in USER_AVATAR_COLORS"
            :key="color.bg"
            class="flex items-center gap-1.5"
          >
            <UAvatar
              v-for="size in (['2xs', 'xs', 'md', 'xl'] as const)"
              :key="size"
              text="AB"
              :size="size"
              :class="color.bg"
              :ui="{ fallback: color.text }"
            />
          </div>
        </div>
      </UCard>
    </section>

    <!-- Lists Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Lists
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <UCard>
          <template #header>
            <h3>Unordered List</h3>
          </template>
          <ul>
            <li>First item in the list</li>
            <li>Second item in the list</li>
            <li>
              Third item with nested list:
              <ul>
                <li>Nested item 1</li>
                <li>Nested item 2</li>
              </ul>
            </li>
            <li>Fourth item in the list</li>
          </ul>
        </UCard>

        <UCard>
          <template #header>
            <h3>Ordered List</h3>
          </template>
          <ol>
            <li>First step</li>
            <li>Second step</li>
            <li>
              Third step with nested:
              <ol>
                <li>Substep 1</li>
                <li>Substep 2</li>
              </ol>
            </li>
            <li>Fourth step</li>
          </ol>
        </UCard>
      </div>
    </section>

    <!-- Table Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Table
      </h2>
      <UCard>
        <UTable
          :columns="tableColumns"
          :data="tableRows"
        />
      </UCard>
    </section>

    <!-- Code Block Section -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Code Blocks
      </h2>
      <UCard>
        <template #header>
          <h3>Code Example</h3>
        </template>
        <p>Inline code: <code>const x = 10;</code></p>
        <pre><code>// JavaScript Example
function greet(name) {
  console.log(`Hello, ${name}!`);
}

greet('World');</code></pre>
      </UCard>
    </section>

    <!-- Dividers & Spacing -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Dividers & Spacing
      </h2>
      <UCard>
        <p>Content above divider</p>
        <USeparator />
        <p>Content below divider</p>
        <USeparator />
        <p>Another section with different spacing</p>
      </UCard>
    </section>

    <!-- Loading States -->
    <section class="mb-12">
      <h2 class="text-2xl font-semibold mb-4 pb-2 border-b border-(--ui-border)">
        Loading States
      </h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <UCard>
          <template #header>
            <h3>Loading Buttons</h3>
          </template>
          <div class="button-grid">
            <UButton loading>
              Loading
            </UButton>
            <UButton
              loading
              size="lg"
            >
              Large Loading
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3>Skeleton Loading</h3>
          </template>
          <div class="space-y-3">
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-4 w-[60%]" />
          </div>
        </UCard>
      </div>
    </section>
  </div>
</template>

<style scoped>
.button-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.link-showcase {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.card-footer {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}

.stat-item {
  text-align: center;
}

.stat-value {
  font-size: 1.875rem;
  font-weight: bold;
  color: var(--ui-text);
  margin-bottom: 0.25rem;
}

.stat-label {
  font-size: 0.875rem;
  color: var(--ui-text-muted);
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  color: var(--ui-text);
  font-weight: 500;
}

.badge-showcase {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

@media (max-width: 768px) {
  .stats {
    grid-template-columns: 1fr;
  }

  .button-grid {
    flex-direction: column;
  }
}
</style>
