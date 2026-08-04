/** Schema de tool no formato Anthropic (reutilizado pelo loop OpenAI). */

/** Propriedade JSON Schema (MCP pode trazer anyOf/items/object aninhado). */
export type JsonSchemaProperty = Record<string, unknown>

export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, JsonSchemaProperty>
    required?: string[]
    additionalProperties?: boolean | JsonSchemaProperty
    $schema?: string
  }
}
