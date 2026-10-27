/**
 * Stand-in for `@deepseek-ai/dsh-tools` used only by the offline harness.
 *
 * The real package is resolved by the DSH loader's module registry, so plain
 * Node cannot import it. This stub reproduces the one thing the harness needs
 * to trust: the author-schema validation `defineTool`/`tools.register` performs
 * on tool definitions (allowed keywords per node type, mandatory boolean
 * `additionalProperties` on objects, `required: true` when present). A tool
 * definition that would throw JsonSchemaError at load time throws here too.
 */

/** Annotation keys the value-schema DSL accepts on any node. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/**
 * Report one author-schema violation the way the real compiler does.
 * @param path - the failing node path.
 * @param message - the violation.
 */
function authorError(path, message) {
  throw new Error(`JsonSchemaError: ${path}.${message}`)
}

/**
 * Reject keys outside one node's declared vocabulary.
 * @param node - the authored node.
 * @param path - the node path.
 * @param allowed - keys the node type accepts.
 */
function assertAuthorKeys(node, path, allowed) {
  for (const key of Object.keys(node)) if (!allowed.includes(key)) authorError(path, `${key} is not supported by the value schema DSL`)
}

/**
 * Validate one authored node exactly as the runtime compiler would.
 * @param node - the authored node.
 * @param path - the node path.
 * @param allowRequired - whether `required` is accepted here.
 */
function validateNode(node, path, allowRequired) {
  if (node === null || typeof node !== 'object') authorError(path, 'must be an object')
  if (Object.hasOwn(node, 'required') && node.required !== true) authorError(path, 'required must be true when present')
  const authorKeys = [...ANNOTATION_KEYS, ...allowRequired ? ['required'] : []]
  if (Object.hasOwn(node, 'oneOf')) {
    assertAuthorKeys(node, path, [...authorKeys, 'oneOf', 'type'])
    if (Object.hasOwn(node, 'type')) authorError(path, 'cannot declare both type and oneOf')
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) authorError(path, 'oneOf must be an array of at least two value schemas')
    node.oneOf.forEach((branch, index) => validateNode(branch, `${path}.oneOf[${index}]`, false))
    return
  }
  switch (node.type) {
    case 'json':
      assertAuthorKeys(node, path, [...authorKeys, 'type'])
      return
    case 'object':
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      if (typeof node.additionalProperties !== 'boolean') authorError(path, 'additionalProperties must be explicitly true or false')
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        validateNode(child, `${path}.properties.${key}`, true)
      }
      return
    case 'array':
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'items'])
      if (Object.hasOwn(node, 'items')) validateNode(node.items, `${path}.items`, false)
      return
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      assertAuthorKeys(node, path, [...authorKeys, 'type', 'enum', 'const'])
      return
    default:
      authorError(path, `unsupported type ${String(node.type)}`)
  }
}

/**
 * Validate one tool definition and return it unchanged.
 * @param definition - the authored tool definition.
 * @returns the same definition.
 */
export function defineTool(definition) {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) throw new Error('JsonSchemaError: tool name is required')
  if (typeof definition.description !== 'string' || definition.description.length === 0) throw new Error('JsonSchemaError: tool description is required')
  if (typeof definition.execute !== 'function') throw new Error('JsonSchemaError: tool execute is required')
  const output = definition.output
  if (output === undefined || typeof output !== 'object') throw new Error('JsonSchemaError: tool output is required')
  if (typeof output.render !== 'function') throw new Error(`JsonSchemaError: tool "${definition.name}" must declare output.render`)
  validateNode(output.schema, `${definition.name}.output.schema`, false)
  for (const [key, child] of Object.entries(definition.parameters ?? {})) {
    validateNode(child, `${definition.name}.parameters.${key}`, true)
  }
  return definition
}
