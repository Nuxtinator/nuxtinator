// Puts the link to a task's subtasks board in the heading of its list of
// subtasks on the record's details. Registered at app-plugin time, so it is
// in place before any record renders.
import { registerRecordsChildrenAction } from '#records'
import ViewsSubtasksBoardLink from '../components/views/SubtasksBoardLink.vue'
import { VIEWS_SUBTASKS_TYPE } from '../utils/views-types'

export default defineNuxtPlugin(() => {
  registerRecordsChildrenAction({
    id: 'views:subtasks-board',
    recordTypes: [VIEWS_SUBTASKS_TYPE],
    component: ViewsSubtasksBoardLink
  })
})
