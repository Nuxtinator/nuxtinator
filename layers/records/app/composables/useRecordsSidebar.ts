// The records sidebar switches between record types, so it shows only when
// there is more than one type to switch between.

export function useRecordsSidebar() {
  const { visibleTypes } = useRecordsTypes()
  const shown = computed(() => visibleTypes.value.length > 1)
  return { shown }
}
