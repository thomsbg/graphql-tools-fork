import {
  DefinitionNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLType,
  GraphQLUnionType,
  InputObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  TypeNode,
  UnionTypeDefinitionNode,
  GraphQLDirective,
  DirectiveDefinitionNode,
  DirectiveLocationEnum,
  DirectiveLocation,
  GraphQLFieldConfig,
  StringValueNode,
  Location,
  TokenKind,
} from 'graphql';

import { createNamedStub, graphqlVersion } from '../utils';

import resolveFromParentTypename from './resolveFromParentTypename';

const backcompatOptions = { commentDescriptions: true };

export type GetType = (
  name: string,
  // this is a hack
  type: 'object' | 'interface' | 'input',
) => GraphQLObjectType | GraphQLInputObjectType | GraphQLInterfaceType;

export default function typeFromAST(
  node: DefinitionNode,
): GraphQLNamedType | GraphQLDirective | null {
  switch (node.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
      return makeObjectType(node);
    case Kind.INTERFACE_TYPE_DEFINITION:
      return makeInterfaceType(node);
    case Kind.ENUM_TYPE_DEFINITION:
      return makeEnumType(node);
    case Kind.UNION_TYPE_DEFINITION:
      return makeUnionType(node);
    case Kind.SCALAR_TYPE_DEFINITION:
      return makeScalarType(node);
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return makeInputObjectType(node);
    case Kind.DIRECTIVE_DEFINITION:
      return makeDirective(node);
    default:
      return null;
  }
}

function makeObjectType(node: ObjectTypeDefinitionNode): GraphQLObjectType {
  const config = {
    name: node.name.value,
    fields: () => makeFields(node.fields),
    interfaces: () =>
      node.interfaces.map(
        iface =>
          createNamedStub(
            iface.name.value,
            'interface',
          ) as GraphQLInterfaceType,
      ),
    description: getDescription(node, backcompatOptions),
  };
  return new GraphQLObjectType(config);
}

function makeInterfaceType(
  node: InterfaceTypeDefinitionNode,
): GraphQLInterfaceType {
  const config = {
    name: node.name.value,
    fields: () => makeFields(node.fields),
    interfaces:
      graphqlVersion() >= 15
        ? () =>
            ((node as unknown) as ObjectTypeDefinitionNode).interfaces.map(
              iface =>
                createNamedStub(
                  iface.name.value,
                  'interface',
                ) as GraphQLInterfaceType,
            )
        : undefined,
    description: getDescription(node, backcompatOptions),
    resolveType: (parent: any) => resolveFromParentTypename(parent),
  };
  return new GraphQLInterfaceType(config);
}

function makeEnumType(node: EnumTypeDefinitionNode): GraphQLEnumType {
  const values = {};
  node.values.forEach(value => {
    values[value.name.value] = {
      description: getDescription(value, backcompatOptions),
    };
  });
  return new GraphQLEnumType({
    name: node.name.value,
    values,
    description: getDescription(node, backcompatOptions),
  });
}

function makeUnionType(node: UnionTypeDefinitionNode): GraphQLUnionType {
  return new GraphQLUnionType({
    name: node.name.value,
    types: () =>
      node.types.map(type => resolveType(type, 'object') as GraphQLObjectType),
    description: getDescription(node, backcompatOptions),
    resolveType: parent => resolveFromParentTypename(parent),
  });
}

function makeScalarType(node: ScalarTypeDefinitionNode): GraphQLScalarType {
  return new GraphQLScalarType({
    name: node.name.value,
    description: getDescription(node, backcompatOptions),
    serialize: () => null,
    // Note: validation calls the parse functions to determine if a
    // literal value is correct. Returning null would cause use of custom
    // scalars to always fail validation. Returning false causes them to
    // always pass validation.
    parseValue: () => false,
    parseLiteral: () => false,
  });
}

function makeInputObjectType(
  node: InputObjectTypeDefinitionNode,
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: node.name.value,
    fields: () => makeValues(node.fields),
    description: getDescription(node, backcompatOptions),
  });
}

function makeFields(
  nodes: ReadonlyArray<FieldDefinitionNode>,
): Record<string, GraphQLFieldConfig<any, any>> {
  const result: Record<string, GraphQLFieldConfig<any, any>> = {};
  nodes.forEach(node => {
    const deprecatedDirective = node.directives.find(
      directive => directive.name.value === 'deprecated',
    );

    let deprecationReason;

    if (deprecatedDirective != null) {
      const deprecatedArgument = deprecatedDirective.arguments.find(
        arg => arg.name.value === 'reason',
      );
      deprecationReason = (deprecatedArgument.value as StringValueNode).value;
    }

    result[node.name.value] = {
      type: resolveType(node.type, 'object') as GraphQLObjectType,
      args: makeValues(node.arguments),
      description: getDescription(node, backcompatOptions),
      deprecationReason,
    };
  });
  return result;
}

function makeValues(nodes: ReadonlyArray<InputValueDefinitionNode>) {
  const result = {};
  nodes.forEach(node => {
    const type = resolveType(node.type, 'input') as GraphQLInputType;
    result[node.name.value] = {
      type,
      defaultValue: node.defaultValue,
      description: getDescription(node, backcompatOptions),
    };
  });
  return result;
}

function resolveType(
  node: TypeNode,
  type: 'object' | 'interface' | 'input',
): GraphQLType {
  switch (node.kind) {
    case Kind.LIST_TYPE:
      return new GraphQLList(resolveType(node.type, type));
    case Kind.NON_NULL_TYPE:
      return new GraphQLNonNull(resolveType(node.type, type));
    default:
      return createNamedStub(node.name.value, type);
  }
}

function makeDirective(node: DirectiveDefinitionNode): GraphQLDirective {
  const locations: Array<DirectiveLocationEnum> = [];
  node.locations.forEach(location => {
    if (location.value in DirectiveLocation) {
      locations.push(location.value as DirectiveLocationEnum);
    }
  });
  return new GraphQLDirective({
    name: node.name.value,
    description: node.description != null ? node.description.value : null,
    args: makeValues(node.arguments),
    locations,
  });
}

// graphql < v13 does not export getDescription

function getDescription(
  node: { description?: StringValueNode; loc?: Location },
  options?: { commentDescriptions?: boolean },
): string {
  if (node.description != null) {
    return node.description.value;
  }
  if (options.commentDescriptions) {
    const rawValue = getLeadingCommentBlock(node);
    if (rawValue !== undefined) {
      return dedentBlockStringValue(`\n${rawValue as string}`);
    }
  }
}

function getLeadingCommentBlock(node: {
  description?: StringValueNode;
  loc?: Location;
}): void | string {
  const loc = node.loc;
  if (!loc) {
    return;
  }
  const comments = [];
  let token = loc.startToken.prev;
  while (
    token != null &&
    token.kind === TokenKind.COMMENT &&
    token.next != null &&
    token.prev != null &&
    token.line + 1 === token.next.line &&
    token.line !== token.prev.line
  ) {
    const value = String(token.value);
    comments.push(value);
    token = token.prev;
  }
  return comments.length > 0 ? comments.reverse().join('\n') : undefined;
}

function dedentBlockStringValue(rawString: string): string {
  // Expand a block string's raw value into independent lines.
  const lines = rawString.split(/\r\n|[\n\r]/g);

  // Remove common indentation from all lines but first.
  const commonIndent = getBlockStringIndentation(lines);

  if (commonIndent !== 0) {
    for (let i = 1; i < lines.length; i++) {
      lines[i] = lines[i].slice(commonIndent);
    }
  }

  // Remove leading and trailing blank lines.
  while (lines.length > 0 && isBlank(lines[0])) {
    lines.shift();
  }
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) {
    lines.pop();
  }

  // Return a string of the lines joined with U+000A.
  return lines.join('\n');
}
/**
 * @internal
 */
export function getBlockStringIndentation(
  lines: ReadonlyArray<string>,
): number {
  let commonIndent = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = leadingWhitespace(line);
    if (indent === line.length) {
      continue; // skip empty lines
    }

    if (commonIndent === null || indent < commonIndent) {
      commonIndent = indent;
      if (commonIndent === 0) {
        break;
      }
    }
  }

  return commonIndent === null ? 0 : commonIndent;
}

function leadingWhitespace(str: string) {
  let i = 0;
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    i++;
  }
  return i;
}

function isBlank(str: string) {
  return leadingWhitespace(str) === str.length;
}
