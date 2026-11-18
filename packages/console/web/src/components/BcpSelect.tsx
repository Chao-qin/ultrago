import { Select } from "antd";
import type { SelectProps } from "antd";
import type { BaseOptionType, DefaultOptionType } from "antd/es/select";

/**
 * The console's only dropdown. Every list, page and form control picks options
 * through this one — plain `Select` imports outside this file are the thing a
 * review greps for.
 *
 * Three defaults, each fixing a drift that actually happened:
 *
 * - `showSearch: true` — a dropdown someone has to scroll is a dropdown that
 *   makes them read; every list in this console is navigated by typing once it
 *   passes a dozen options. The two dozen call sites had this on, off, or
 *   forgotten depending on when each was written.
 * - `optionFilterProp: "label"` — matches what the eye sees. Options carrying
 *   rich labels (schema registry rows render two lines of JSX) override this
 *   with `optionFilterProp="search"` against a hidden search string; that
 *   arrangement is per-call-site data, not a reason to fork the component.
 * - `virtual: false` — antd's virtual list measures ONE row height for the
 *   whole list. Anywhere options mix heights (one-line presets beside two-line
 *   registry entries) scrolling renders duplicates and floating gaps, and the
 *   bug reads as "the list is haunted" rather than "virtualisation can't
 *   measure two heights". Rendering ~60 options (the largest fixed list — cron
 *   minutes) or a few hundred registry rows (navigated by search, never by
 *   scroll) is cheap; the duplicated-rows bug is not. A single-height,
 *   thousand-row list can opt back in with `virtual` if one ever appears.
 *
 * The generics mirror antd's own so call-site inference is unchanged — a
 * boolean-valued options list (the constant field's true/false) keeps working.
 */
export function BcpSelect<
  ValueType = any,
  OptionType extends BaseOptionType | DefaultOptionType = DefaultOptionType,
>({
  showSearch = true,
  optionFilterProp = "label",
  virtual = false,
  popupAlign = { offset: [0, 0], overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true } },
  ...rest
}: SelectProps<ValueType, OptionType>): JSX.Element {
  return <Select showSearch={showSearch} optionFilterProp={optionFilterProp} virtual={virtual} popupAlign={popupAlign} {...rest} />;
}
