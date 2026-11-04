/**
 * entry.js — registers <helpinator-widget>.
 *
 *   <script src="https://<host>/js/helpinator-widget.iife.js" defer></script>
 *   <helpinator-widget host="https://<host>" widget-id="<uuid>"></helpinator-widget>
 *
 * Everything else (colour, texts, position) comes from the widget's config on
 * the server. Per-site styling: set CSS custom properties on the element from
 * the host page — see README.md.
 */
import { defineCustomElement } from 'vue'
import HelpinatorWidget from './HelpinatorWidget.ce.vue'

const HelpinatorWidgetElement = defineCustomElement(HelpinatorWidget)

if (!customElements.get('helpinator-widget')) {
  customElements.define('helpinator-widget', HelpinatorWidgetElement)
}

export default HelpinatorWidgetElement
