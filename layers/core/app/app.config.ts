export default defineAppConfig({
  ui: {
    colors: {
      primary: 'green',
      neutral: 'slate'
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
