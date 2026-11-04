<script setup lang="ts">
import KanbanColumn from './KanbanColumn.vue'
import KanbanCell from './KanbanCell.vue'
import type {
  KanbanCardModel as Card,
  KanbanColumnModel as Column,
  KanbanSwimlaneModel as Swimlane,
  KanbanProjectModel as Project
} from './types'

const props = defineProps<{
  projects: Project[]
  columns: Column[]
  swimlanes: Swimlane[]
  cards: Card[]
  scope?: string
  // Single-project view: lane rows split the container height evenly and cells
  // scroll internally, so the board uses the full screen height. Manual row
  // resizing and project reordering are disabled in this mode.
  fillHeight?: boolean
}>()

const emit = defineEmits<{
  addCard: [payload: { columnId: string; swimlaneId: string; projectId: string }]
  cardClick: [card: Card]
  cardContextMenu: [payload: { card: Card; x: number; y: number }]
  cardDrop: [payload: { card: Card; toColumnId: string; toSwimlaneId: string; toProjectId: string }]
  addSwimlane: [projectId: string]
  renameProject: [project: Project]
  reorderColumn: [payload: { draggedId: string; targetId: string }]
  reorderProjects: [payload: { orderedIds: string[] }]
  projectContextMenu: [payload: { x: number; y: number; project: Project }]
  columnContextMenu: [payload: { x: number; y: number; column: Column }]
  requestAddProject: []
  toggleProjectExpand: [project: Project]
}>()

function isProjectExpanded(project: Project): boolean {
  return (project as any).is_expanded === true
}

function defaultLaneOf(projectId: string): Swimlane | undefined {
  const lanes = lanesOf(projectId)
  return lanes.find(l => l.is_default) ?? lanes[0]
}

// A project always has a default swimlane; the expand/collapse chevron only
// reveals something new when there's at least one additional lane.
function hasMultipleLanes(projectId: string): boolean {
  return lanesOf(projectId).length > 1
}

function allLaneIdsOf(projectId: string): string[] {
  return props.swimlanes.filter(s => s.project_id === projectId).map(s => s.id)
}

const { heights: rowHeights, getHeight, setHeight, laneKey, projectKey, MIN_HEIGHT, MAX_HEIGHT } = useSwimlaneHeight()

function keyForLane(_projectId: string, swimlaneId: string): string {
  return props.scope ? laneKey(props.scope, swimlaneId) : `_/${swimlaneId}`
}
function keyForPooled(projectId: string): string {
  return props.scope ? projectKey(props.scope, projectId) : `_project/${projectId}`
}
function heightFor(key: string): number {
  const v = rowHeights.value[key]
  return typeof v === 'number' && v >= MIN_HEIGHT ? v : getHeight(key)
}

const resizingKey = ref<string | null>(null)
const resizeStartY = ref(0)
const resizeStartH = ref(0)

function onResizeDown(e: MouseEvent, key: string) {
  e.preventDefault()
  resizingKey.value = key
  resizeStartY.value = e.clientY
  resizeStartH.value = heightFor(key)
  if (import.meta.client) {
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }
}

function onResizeMove(e: MouseEvent) {
  if (!resizingKey.value) return
  const dy = e.clientY - resizeStartY.value
  const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, resizeStartH.value + dy))
  setHeight(resizingKey.value, next)
}

function onResizeUp() {
  resizingKey.value = null
  if (import.meta.client) {
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

onBeforeUnmount(() => {
  if (import.meta.client) {
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
})

const dragOverColumnId = ref<string | null>(null)

function onColumnDragStart(e: DragEvent, col: Column) {
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('application/column', col.id)
}

function onColumnDragOver(e: DragEvent, col: Column) {
  e.preventDefault()
  dragOverColumnId.value = col.id
}

function onColumnDragLeave() {
  dragOverColumnId.value = null
}

function onColumnDrop(e: DragEvent, targetCol: Column) {
  e.preventDefault()
  dragOverColumnId.value = null
  const draggedId = e.dataTransfer?.getData('application/column')
  if (draggedId && draggedId !== targetCol.id) {
    emit('reorderColumn', { draggedId, targetId: targetCol.id })
  }
}

function onColumnDragEnd() {
  dragOverColumnId.value = null
}

const dragOverProjectId = ref<string | null>(null)
let draggedProjectId: string | null = null

function onProjectDragStart(e: DragEvent, project: Project) {
  if (!e.dataTransfer) return
  draggedProjectId = project.id
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('application/project', project.id)
}

function onProjectDragOver(e: DragEvent, project: Project) {
  e.preventDefault()
  if (draggedProjectId && draggedProjectId !== project.id) {
    dragOverProjectId.value = project.id
  }
}

function onProjectDragLeave() {
  dragOverProjectId.value = null
}

function onProjectDrop(e: DragEvent, targetProject: Project) {
  e.preventDefault()
  dragOverProjectId.value = null
  const fromId = e.dataTransfer?.getData('application/project') ?? draggedProjectId
  draggedProjectId = null
  if (!fromId || fromId === targetProject.id) return

  const list = [...props.projects]
  const fromIdx = list.findIndex(p => p.id === fromId)
  const toIdx = list.findIndex(p => p.id === targetProject.id)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = list.splice(fromIdx, 1)
  list.splice(toIdx, 0, moved!)
  emit('reorderProjects', { orderedIds: list.map(p => p.id) })
}

function onProjectDragEnd() {
  dragOverProjectId.value = null
  draggedProjectId = null
}

const sortedColumns = computed(() => [...props.columns].sort((a, b) => a.position - b.position))

function lanesOf(projectId: string): Swimlane[] {
  return props.swimlanes
    .filter(s => s.project_id === projectId)
    .sort((a, b) => {
      if (a.is_default && !b.is_default) return -1
      if (b.is_default && !a.is_default) return 1
      return a.position - b.position
    })
}

function projectCardCount(projectId: string): number {
  return props.cards.filter(c => c.project_id === projectId).length
}

// Column headers count only cards belonging to the projects on display, so a
// single-project view doesn't show totals from projects it isn't rendering.
function cardCountInColumn(columnId: string): number {
  const visible = new Set(props.projects.map(p => p.id))
  return props.cards.filter(c => c.column_id === columnId && visible.has(c.project_id)).length
}

// In fill (single-project) mode the label column shrinks to a slim rail —
// the project name already sits in the page header, so the rail only carries
// vertically-written labels.
const gridTemplate = computed(
  () => `${props.fillHeight ? '40px' : '160px'} repeat(${sortedColumns.value.length}, minmax(240px, 1fr))`
)

// One grid row per rendered lane row: pooled (collapsed) projects contribute
// one, expanded projects one per swimlane. Drives the explicit row template
// in fill mode so each lane row gets an equal share of the height.
const laneRowCount = computed(() =>
  props.projects.reduce((n, p) =>
    n + (isProjectExpanded(p) ? lanesOf(p.id).length : (defaultLaneOf(p.id) ? 1 : 0)), 0)
)

const gridStyle = computed(() => ({
  gridTemplateColumns: gridTemplate.value,
  ...(props.fillHeight
    ? { gridTemplateRows: `auto repeat(${laneRowCount.value}, minmax(0, 1fr))` }
    : {})
}))
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <div
      class="min-w-fit grid"
      :class="fillHeight ? 'h-full' : ''"
      :style="gridStyle"
    >
      <div
        class="border-b border-r border-(--ui-border) sticky top-0 z-10"
        :class="fillHeight
          ? 'bg-primary-500/10'
          : 'px-3 py-2 bg-(--ui-bg-elevated) text-xs font-semibold uppercase text-(--ui-text-muted)'"
      >
        <template v-if="!fillHeight">
          Projects
        </template>
      </div>
      <div
        v-for="col in sortedColumns"
        :key="col.id"
        class="sticky top-0 z-10"
        :class="dragOverColumnId === col.id ? 'border-l-2 border-l-primary-500' : ''"
        draggable="true"
        @dragstart="onColumnDragStart($event, col)"
        @dragover="onColumnDragOver($event, col)"
        @dragleave="onColumnDragLeave"
        @drop="onColumnDrop($event, col)"
        @dragend="onColumnDragEnd"
        @contextmenu.prevent="emit('columnContextMenu', { x: $event.clientX, y: $event.clientY, column: col })"
      >
        <KanbanColumn
          :column="col"
          :card-count="cardCountInColumn(col.id)"
          :scope="scope"
        />
      </div>

      <template v-for="project in projects" :key="project.id">
        <template v-if="!isProjectExpanded(project) && defaultLaneOf(project.id)">
          <div
            class="border-b border-r border-(--ui-border) flex min-w-0 group/projrow"
            :class="[
              fillHeight
                ? 'bg-primary-500/10 flex-col items-center gap-1 px-1 py-2'
                : 'px-3 py-2 bg-(--ui-bg-muted) items-center gap-2 cursor-grab',
              dragOverProjectId === project.id ? 'border-l-2 border-l-primary-500' : ''
            ]"
            :draggable="fillHeight ? 'false' : 'true'"
            @dragstart="onProjectDragStart($event, project)"
            @dragover="onProjectDragOver($event, project)"
            @dragleave="onProjectDragLeave()"
            @drop="onProjectDrop($event, project)"
            @dragend="onProjectDragEnd()"
            @contextmenu.prevent="emit('projectContextMenu', { x: $event.clientX, y: $event.clientY, project })"
          >
            <template v-if="fillHeight">
              <button
                v-if="hasMultipleLanes(project.id)"
                type="button"
                class="shrink-0 text-(--ui-text-muted) hover:text-(--ui-text) p-0.5"
                :title="`Expand ${project.name} — show swimlanes`"
                @click.stop="emit('toggleProjectExpand', project)"
              >
                <UIcon name="i-lucide-chevron-right" class="w-4 h-4" />
              </button>
              <span
                class="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold tracking-wide text-(--ui-text-muted) flex-1 min-h-0 truncate"
                :title="project.name"
              >{{ project.name }}</span>
              <span class="text-[10px] text-(--ui-text-muted) shrink-0">
                {{ projectCardCount(project.id) }}
              </span>
            </template>
            <template v-else>
              <button
                v-if="hasMultipleLanes(project.id)"
                type="button"
                class="shrink-0 text-(--ui-text-muted) hover:text-(--ui-text) p-0.5"
                :title="`Expand ${project.name} — show swimlanes`"
                @click.stop="emit('toggleProjectExpand', project)"
              >
                <UIcon name="i-lucide-chevron-right" class="w-4 h-4" />
              </button>
              <span v-else class="shrink-0 w-5" aria-hidden="true" />
              <span class="text-sm font-semibold truncate flex-1 min-w-0">{{ project.name }}</span>
              <span class="text-[11px] text-(--ui-text-muted) shrink-0">
                {{ projectCardCount(project.id) }}
              </span>
              <div class="ml-auto hidden group-hover/projrow:flex items-center gap-1">
                <UButton
                  icon="i-lucide-plus"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  aria-label="Add swimlane"
                  @click.stop="emit('addSwimlane', project.id)"
                />
                <UButton
                  icon="i-lucide-settings"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  aria-label="Project settings"
                  @click.stop="emit('renameProject', project)"
                />
              </div>
            </template>
          </div>
          <KanbanCell
            v-for="col in sortedColumns"
            :key="`${col.id}-${project.id}-pooled`"
            :column="col"
            :swimlane="defaultLaneOf(project.id)!"
            :project="project"
            :scope="scope"
            :cards="cards"
            :swimlane-filter-ids="allLaneIdsOf(project.id)"
            :height-px="fillHeight ? undefined : heightFor(keyForPooled(project.id))"
            :fill="fillHeight"
            @add-card="(p) => emit('addCard', p)"
            @card-click="(c) => emit('cardClick', c)"
            @card-context-menu="(p) => emit('cardContextMenu', p)"
            @card-drop="(p) => emit('cardDrop', p)"
          />
          <div
            v-if="!fillHeight"
            class="swimlane-resize-handle"
            :class="resizingKey === keyForPooled(project.id) ? 'active' : ''"
            :style="{ gridColumn: '1 / -1' }"
            title="Drag to resize row height"
            @mousedown="onResizeDown($event, keyForPooled(project.id))"
          />
        </template>

        <template v-else>
          <template v-for="(lane, idx) in lanesOf(project.id)" :key="lane.id">
            <div
              class="border-b border-r border-(--ui-border) flex min-w-0"
              :class="[
                fillHeight
                  ? 'bg-primary-500/10 flex-col items-center gap-1 px-1 py-2'
                  : ['px-3 py-2 bg-(--ui-bg-muted) items-center gap-2', idx === 0 ? 'cursor-grab' : 'pl-10'],
                idx === 0 ? 'group/projrow' : '',
                dragOverProjectId === project.id && idx === 0 ? 'border-l-2 border-l-primary-500' : ''
              ]"
              :draggable="idx === 0 && !fillHeight ? 'true' : 'false'"
              @dragstart="idx === 0 && onProjectDragStart($event, project)"
              @dragover="idx === 0 && onProjectDragOver($event, project)"
              @dragleave="idx === 0 && onProjectDragLeave()"
              @drop="idx === 0 && onProjectDrop($event, project)"
              @dragend="idx === 0 && onProjectDragEnd()"
              @contextmenu.prevent="idx === 0 && emit('projectContextMenu', { x: $event.clientX, y: $event.clientY, project })"
            >
              <template v-if="fillHeight">
                <template v-if="idx === 0">
                  <button
                    v-if="hasMultipleLanes(project.id)"
                    type="button"
                    class="shrink-0 text-(--ui-text-muted) hover:text-(--ui-text) p-0.5"
                    :title="`Collapse ${project.name}`"
                    @click.stop="emit('toggleProjectExpand', project)"
                  >
                    <UIcon name="i-lucide-chevron-down" class="w-4 h-4" />
                  </button>
                  <span
                    class="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold tracking-wide text-(--ui-text-muted) flex-1 min-h-0 truncate"
                    :title="project.name"
                  >{{ project.name }}</span>
                  <span class="text-[10px] text-(--ui-text-muted) shrink-0">
                    {{ projectCardCount(project.id) }}
                  </span>
                </template>
                <template v-else>
                  <span
                    class="[writing-mode:vertical-rl] rotate-180 text-xs text-(--ui-text-muted) flex-1 min-h-0 truncate"
                    :title="lane.name"
                  >{{ lane.name }}</span>
                </template>
              </template>
              <template v-else-if="idx === 0">
                <button
                  v-if="hasMultipleLanes(project.id)"
                  type="button"
                  class="shrink-0 text-(--ui-text-muted) hover:text-(--ui-text) p-0.5"
                  :title="`Collapse ${project.name}`"
                  @click.stop="emit('toggleProjectExpand', project)"
                >
                  <UIcon name="i-lucide-chevron-down" class="w-4 h-4" />
                </button>
                <span v-else class="shrink-0 w-5" aria-hidden="true" />
                <span class="text-sm font-semibold truncate flex-1 min-w-0">{{ project.name }}</span>
                <span class="text-[11px] text-(--ui-text-muted) shrink-0">
                  {{ projectCardCount(project.id) }}
                </span>
                <div class="ml-auto hidden group-hover/projrow:flex items-center gap-1">
                  <UButton
                    icon="i-lucide-plus"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    aria-label="Add swimlane"
                    @click.stop="emit('addSwimlane', project.id)"
                  />
                  <UButton
                    icon="i-lucide-settings"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    aria-label="Project settings"
                    @click.stop="emit('renameProject', project)"
                  />
                </div>
              </template>
              <template v-else>
                <span class="truncate text-xs text-(--ui-text-muted)">{{ lane.name }}</span>
              </template>
            </div>

            <KanbanCell
              v-for="col in sortedColumns"
              :key="`${col.id}-${lane.id}`"
              :column="col"
              :swimlane="lane"
              :project="project"
              :scope="scope"
              :cards="cards"
              :height-px="fillHeight ? undefined : heightFor(keyForLane(project.id, lane.id))"
              :fill="fillHeight"
              @add-card="(p) => emit('addCard', p)"
              @card-click="(c) => emit('cardClick', c)"
              @card-context-menu="(p) => emit('cardContextMenu', p)"
              @card-drop="(p) => emit('cardDrop', p)"
            />
            <div
              v-if="!fillHeight"
              class="swimlane-resize-handle"
              :class="resizingKey === keyForLane(project.id, lane.id) ? 'active' : ''"
              :style="{ gridColumn: '1 / -1' }"
              :title="`Drag to resize ${lane.name || 'row'} height`"
              @mousedown="onResizeDown($event, keyForLane(project.id, lane.id))"
            />
          </template>
        </template>
      </template>

      <template v-if="!fillHeight">
        <div class="border-b border-r border-(--ui-border) p-2">
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            size="sm"
            @click="emit('requestAddProject')"
          >
            Add project
          </UButton>
        </div>
        <div
          v-for="col in sortedColumns"
          :key="`add-${col.id}`"
          class="border-b border-(--ui-border)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.swimlane-resize-handle {
  height: 6px;
  cursor: ns-resize;
  background: transparent;
  position: relative;
  z-index: 5;
  user-select: none;
  border-bottom: 1px solid transparent;
  transition: background-color 0.1s ease;
}
.swimlane-resize-handle:hover,
.swimlane-resize-handle.active {
  background-color: color-mix(in srgb, currentColor 20%, transparent);
}
.swimlane-resize-handle::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 40px;
  height: 3px;
  background-color: color-mix(in srgb, currentColor 28%, transparent);
  border-radius: 9999px;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.1s ease;
  pointer-events: none;
}
.swimlane-resize-handle:hover::after,
.swimlane-resize-handle.active::after {
  opacity: 1;
}
</style>
