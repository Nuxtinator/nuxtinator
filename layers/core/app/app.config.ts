export default defineAppConfig({
  rail: {
    // The desktop rail starts with names next to its icons.
    expanded: false,
    // The "All apps" link at the top of the rail; `{ title, icon, path }`
    // points it somewhere else.
    launcher: true,
    // The tenancy layer's organization settings link at the bottom of the rail.
    orgSettings: true
  },
  ui: {
    colors: {
      primary: 'green',
      neutral: 'slate'
    },
    toast: {
      slots: {
        close: 'toast-countdown rounded-full'
      }
    },
    card: {
      defaultVariants: {
        variant: 'subtle'
      },
      variants: {
        variant: {
          subtle: {
            root: 'dark:ring-accented'
          }
        }
      }
    }
  }
})
