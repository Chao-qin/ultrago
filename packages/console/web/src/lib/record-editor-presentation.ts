import { equalValues, getValue, isObject } from './record-editor-model';
import type { EditorSchema } from './record-editor-model';

type EnumMeaning = { value: unknown; label: string; description: string };
type FieldPresentation = { title: string; options?: EnumMeaning[] };
export type EditorEnumOption = { value: unknown; raw: string; label: string; description: string; documented: boolean; search: string };

// Meanings match SHOP_PROFILE.md and the official addV2 article 249:
// https://op.jinritemai.com/docs/api-docs/14/249
// Scope and typed value-set checks prevent these labels leaking into unrelated contracts.
const SHOP_FIELDS: Record<string, FieldPresentation> = {
  profileId: { title: '店铺配置标识' },
  shopName: { title: '店铺名称' },
  listing: { title: '商品发布' },
  'listing.productType': { title: '商品类型', options: [
    { value: 0, label: '普通商品', description: '实物商品，使用物流发货。' },
    { value: 3, label: '虚拟商品', description: '非实物交付，需选择对应的虚拟商品提取方式。' },
    { value: 6, label: '玉石闪购', description: '平台定义的玉石闪购商品类型。' },
    { value: 7, label: '云闪购', description: '平台定义的云闪购商品类型。' },
  ] },
  'listing.reduceType': { title: '减库存方式', options: [
    { value: 1, label: '拍下减库存', description: '买家下单时即扣减库存。' },
    { value: 2, label: '付款减库存', description: '买家付款成功后扣减库存。' },
  ] },
  'listing.commit': { title: '保存并提审' },
  'listing.serviceMobile': { title: '客服电话' },
  'listing.startSaleType': { title: '审核后上架方式', options: [
    { value: 0, label: '立即上架售卖', description: '审核通过后立即上架售卖。' },
    { value: 1, label: '放入仓库', description: '审核通过后留在仓库，待后续上架。' },
  ] },
  'listing.pickupMethod': { title: '商品提取方式', options: [
    { value: '0', label: '物流发货', description: '普通商品，通过物流配送。' },
    { value: '1', label: '虚拟商品 · 无凭证', description: '无需物流，也无需电子交易凭证。' },
    { value: '2', label: '虚拟商品 · 电子凭证', description: '通过电子交易凭证交付。' },
    { value: '3', label: '虚拟商品 · 充值直连', description: '通过充值直连完成交付。' },
  ] },
  shipping: { title: '物流与发货' },
  'shipping.freightTemplateId': { title: '运费模板 ID' },
  'shipping.presellType': { title: '发货模式', options: [
    { value: 0, label: '现货发货', description: '按现货模式发货，需填写承诺发货时间。' },
    { value: 1, label: '预售发货', description: '按预售模式安排发货。' },
    { value: 2, label: '阶梯发货', description: '按阶梯模式发货，需填写承诺发货时间。' },
  ] },
  'shipping.deliveryDelayDay': { title: '承诺发货时间' },
  'shipping.defaultWeightGram': { title: '默认重量（克）' },
  afterSale: { title: '售后服务' },
  'afterSale.sevenDayReturnPolicy': { title: '无理由退货政策' },
  'afterSale.damagedOrderReturn': { title: '坏损包退', options: [
    { value: 0, label: '不支持', description: '不提供坏损包退服务。' },
    { value: 1, label: '支持坏损包退', description: '提供坏损包退服务。' },
  ] },
  brand: { title: '品牌配置' },
  pricing: { title: '定价策略' },
};
const PRICING: FieldPresentation = { title: '定价方式', options: [
  { value: 'fixed_amount', label: '固定金额加价', description: '售价 = 来源价 + 固定加价金额。' },
  { value: 'percentage', label: '百分比加价', description: '售价 = 来源价 ×（1 + 加价百分比 ÷ 100）。' },
  { value: 'percentage_plus_fixed', label: '百分比 + 固定金额', description: '按百分比加价后，再追加固定金额。' },
  { value: 'min_max', label: '加价并限制上下限', description: '固定加价后，将售价限制在设定的最低价与最高价之间。' },
] };
const CONFIG_FIELDS: Record<string, FieldPresentation> = {
  configId: { title: '配置标识' },
  shopProfile: { title: '店铺配置' },
  pricing: { title: '定价策略' },
  'pricing.strategy': PRICING,
  text: { title: '文案处理' },
  sku: { title: 'SKU 策略' },
  images: { title: '图片处理' },
};
const PRESENTATIONS: Record<string, { versions: number[]; fields: Record<string, FieldPresentation> }> = {
  'shop-profile': { versions: [1, 2], fields: SHOP_FIELDS },
  'product-preprocess-config': { versions: [1], fields: CONFIG_FIELDS },
  'canonical-product': { versions: [1, 2, 3, 6, 7], fields: SHOP_FIELDS },
};

export function presentRecordSchema(schema: EditorSchema, name: string, version: number): EditorSchema {
  const catalog = PRESENTATIONS[name];
  if (!catalog || !catalog.versions.includes(version)) return schema;
  const result = structuredClone(schema);
  for (const [path, presentation] of Object.entries(catalog.fields)) {
    const field = getValue(result, path.split('.').flatMap((key) => ['properties', key]));
    if (!isObject(field)) continue;
    if (typeof field.title !== 'string') field.title = presentation.title;
    if (!presentation.options || !Array.isArray(field.enum)) continue;
    const values = field.enum;
    const meanings = presentation.options;
    if (values.length !== meanings.length || !values.every((value) => meanings.some((meaning) => equalValues(value, meaning.value)))) continue;
    if (Array.isArray(field.oneOf) || Array.isArray(field.anyOf)) continue;
    if (field['x-enumNames'] === undefined && field.enumNames === undefined) {
      field['x-enumNames'] = values.map((value) => meanings.find((meaning) => equalValues(value, meaning.value))!.label);
    }
    if (field['x-enumDescriptions'] === undefined && field.enumDescriptions === undefined && field['x-enum-descriptions'] === undefined) {
      field['x-enumDescriptions'] = values.map((value) => meanings.find((meaning) => equalValues(value, meaning.value))!.description);
    }
  }
  return result;
}

export function editorEnumOptions(schema: EditorSchema): EditorEnumOption[] | null {
  const alternatives = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const constOptions = alternatives.length > 0 && alternatives.every((item) => isObject(item) && Object.hasOwn(item, 'const')) ? alternatives as EditorSchema[] : [];
  const values = Array.isArray(schema.enum) ? schema.enum : constOptions.length ? constOptions.map((item) => item.const) : null;
  if (!values) return null;
  const names = Array.isArray(schema['x-enumNames']) ? schema['x-enumNames'] : Array.isArray(schema.enumNames) ? schema.enumNames : [];
  const descriptions = schema['x-enumDescriptions'] ?? schema.enumDescriptions ?? schema['x-enum-descriptions'];
  return values.map((value, index) => {
    const alternative = constOptions.find((item) => equalValues(item.const, value));
    const raw = JSON.stringify(value) ?? String(value);
    const explicitName = typeof names[index] === 'string' && names[index] ? names[index] : alternative?.title;
    const label = typeof explicitName === 'string' ? explicitName : typeof value === 'string' ? value : raw;
    const detail = Array.isArray(descriptions) ? descriptions[index] : isObject(descriptions) && Object.hasOwn(descriptions, String(value)) ? descriptions[String(value)] : alternative?.description;
    const description = typeof detail === 'string' ? detail : '';
    return { value, raw, label, description, documented: typeof explicitName === 'string' || Boolean(description), search: `${label} ${raw} ${description}`.toLowerCase() };
  });
}
