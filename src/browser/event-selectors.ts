/**
 * Selectors for the event page and the invitee picker.
 *
 * Every one of these was confirmed against the live DOM on 2026-08-01 (see
 * scripts/probe-event*.ts). Two rules the probes proved the hard way:
 *
 *  1. `ember####` ids are regenerated on every render — the same three controls appeared
 *     as ember34/36/195/197 across runs. Never select on them.
 *  2. The location combobox MUST be qualified by its aria-label. Without it,
 *     `input.basic-input[role="combobox"]` also matches the global nav search box, and
 *     typing goes there instead — silently returning companies and schools where you
 *     expected geographies.
 */
export const EVSEL = {
  // --- Event top card ---
  shareButton: 'button.events-components-shared-support-share__share-button',
  inviteMenuItem: 'li.social-share__item--invite-btn[role="menuitem"]',
  menuItem: '[role="menuitem"]',
  openDropdown: '.artdeco-dropdown__content--is-open',
  toastDismiss: '.artdeco-toast-item button[aria-label="Dismiss"]',
  modalDismiss: 'button.artdeco-modal__dismiss',
  anyDialog: 'div[role="dialog"]',

  // --- Invitee picker ---
  pickerModal: 'div[role="dialog"].invitee-picker__modal',
  resultsContainer: '.invitee-picker__results-container',
  resultRow: '.invitee-picker__results-container li[role="option"]',
  rowCheckbox: 'input[type="checkbox"][data-view-name="invitee-suggestion-card"]',
  rowLabel: 'label.invitee-picker-connections-result-item__checkbox',
  a11yText: '.a11y-text',
  loadMoreButton: '.scaffold-finite-scroll__load-button',
  // Note: the filter bar also carries a select-all checkbox
  // (#invitee-picker-filters-bar-select-all-checkbox). It is deliberately absent from
  // this map — it selects the whole filtered page rather than our URN-matched rows, so
  // using it would invite people who are not on the list.

  // --- Locations filter ---
  locationsPill: 'button.search-reusables__filter-pill-button[aria-label^="Locations filter"]',
  locationInput: 'input.basic-input[role="combobox"][aria-label="Add a location"]',
  typeaheadOption: '.basic-typeahead__triggered-content [role="option"]',
  typeaheadHitText: '.search-typeahead-v2__hit-text',
  locationValue: 'input[name="locations-filter-value"]',
  showResults: 'button[aria-label="Apply current filter to show results"]',
} as const;

/**
 * Rows load 50 at a time behind a "Show more results" button, ~1.3s to settle. The list
 * is HARD-CAPPED at 1000 rows in a stable order, so anything past it is permanently
 * invisible under that filter — which is why oversized buckets get sub-sharded.
 */
export const PICKER_ROW_CAP = 1000;
export const PICKER_SETTLE_MS = 1300;
