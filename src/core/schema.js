'use strict';
/**
 * Minimální validátor podmnožiny JSON Schema (type, properties, required, items,
 * enum, minLength, maxLength, minItems, maxItems, minimum, maximum, nullable přes type pole).
 * Bez závislostí; vrací seznam chyb s cestami.
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: očekáván typ ${types.join('|')}, nalezen ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: hodnota ${JSON.stringify(value)} není v ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: kratší než ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: delší než ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: menší než ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: větší než ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: méně než ${schema.minItems} položek`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: více než ${schema.maxItems} položek`);
    if (schema.items) value.forEach((it, i) => validate(schema.items, it, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) {
      if (!(r in value) || value[r] === undefined) errors.push(`${path}.${r}: chybí povinná vlastnost`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value && value[k] !== undefined) validate(sub, value[k], `${path}.${k}`, errors);
    }
  }
  return errors;
}

module.exports = { validate, typeOf };
