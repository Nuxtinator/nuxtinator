// Puts the link to a record's board of what sits under it (a task's
// subtasks) in the heading of that list on the record's details. Registered at app-plugin time, so it is
// in place before any record renders.
import { registerRecordsChildrenAction } from '#records'
import ViewsSubtasksBoardLink from '../components/views/SubtasksBoardLink.vue'

export default defineNuxtPlugin(() => {
  registerRecordsChildrenAction({
    id: 'views:subtasks-board',
    component: ViewsSubtasksBoardLink
  })
})
