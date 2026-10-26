// The CRM sidebar switches between record types and links to the schema
// settings, so it shows only when there is more than one type to switch
// between or the caller can manage the schema.

export function useCrmSidebar() {
  const { visibleTypes } = useCrmTypes()
  const { canManage } = useCrmSchemaAdmin()
  const shown = computed(() => visibleTypes.value.length > 1 || canManage.value === true)
  return { shown }
}
