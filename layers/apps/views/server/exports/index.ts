// Server entry for the `#views/server` alias — what other layers import to
// declare built-in views. Lives outside server/utils so nitro's auto-import
// scan doesn't register these names twice.

export { registerBuiltInView, builtInViewId } from '../utils/builtin-views'
export type { ViewsBuiltInView, ViewsBuiltInTab } from '../utils/builtin-views'
