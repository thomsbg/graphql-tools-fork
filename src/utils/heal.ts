import {
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLType,
  GraphQLUnionType,
  isNamedType,
  GraphQLSchema,
} from 'graphql';
import each from './each';
import updateEachKey from './updateEachKey';
import { VisitableSchemaType } from '../Interfaces';
import { isStub, getBuiltInForStub } from './stub';

type NamedTypeMap = {
  [key: string]: GraphQLNamedType;
};

const hasOwn = Object.prototype.hasOwnProperty;

// Update any references to named schema types that disagree with the named
// types found in schema.getTypeMap().
export function healSchema(schema: GraphQLSchema): GraphQLSchema {
  healTypes(schema.getTypeMap(), schema.getDirectives());
  return schema;
}

export function healTypes(
  originalTypeMap: NamedTypeMap,
  directives: ReadonlyArray<GraphQLDirective>,
  config: {
    skipPruning: boolean;
  } = {
    skipPruning: false,
  }
) {
  const actualNamedTypeMap: NamedTypeMap = Object.create(null);

  // If any of the .name properties of the GraphQLNamedType objects in
  // schema.getTypeMap() have changed, the keys of the type map need to
  // be updated accordingly.

  each(originalTypeMap, (namedType, typeName) => {
    if (!namedType || typeName.startsWith('__')) {
      return;
    }

    const actualName = namedType.name;
    if (actualName.startsWith('__')) {
      return;
    }

    if (hasOwn.call(actualNamedTypeMap, actualName)) {
      throw new Error(`Duplicate schema type name ${actualName}`);
    }

    actualNamedTypeMap[actualName] = namedType;

    // Note: we are deliberately leaving namedType in the schema by its
    // original name (which might be different from actualName), so that
    // references by that name can be healed.
  });

  // Now add back every named type by its actual name.
  each(actualNamedTypeMap, (namedType, typeName) => {
    originalTypeMap[typeName] = namedType;
  });

  // Directive declaration argument types can refer to named types.
  each(directives, (decl: GraphQLDirective) => {
    if (decl.args) {
      updateEachKey(decl.args, arg => {
        arg.type = healType(arg.type);
        return arg.type === null ? null : arg;
      });
    }
  });

  each(originalTypeMap, (namedType, typeName) => {
    // Heal all named types, except for dangling references, kept only to redirect.
    if (! typeName.startsWith('__') &&
        hasOwn.call(actualNamedTypeMap, typeName)) {
      heal(namedType);
    }
  });

  updateEachKey(originalTypeMap, (namedType, typeName) => {
    // Dangling references to renamed types should remain in the schema
    // during healing, but must be removed now, so that the following
    // invariant holds for all names: schema.getType(name).name === name
    if (! typeName.startsWith('__') &&
        ! hasOwn.call(actualNamedTypeMap, typeName)) {
      return null;
    }
  });

  if (!config.skipPruning) {
    pruneTypes(originalTypeMap, directives);
  }

  function heal(type: VisitableSchemaType) {
    if (type instanceof GraphQLObjectType) {
      healFields(type);
      healInterfaces(type);

    } else if (type instanceof GraphQLInterfaceType) {
      healFields(type);

    } else if (type instanceof GraphQLUnionType) {
      healUnderlyingTypes(type);

    } else if (type instanceof GraphQLInputObjectType) {
      healInputFields(type);

    } else if (type instanceof GraphQLScalarType || GraphQLEnumType) {
      // Nothing to do.

    } else {
      throw new Error(`Unexpected schema type: ${type}`);
    }
  }

  function healFields(type: GraphQLObjectType | GraphQLInterfaceType) {
    updateEachKey(type.getFields(), field => {
      if (field.args) {
        updateEachKey(field.args, arg => {
          arg.type = healType(arg.type);
          return arg.type === null ? null : arg;
        });
      }
      field.type = healType(field.type);
      return field.type === null ? null : field;
    });
  }

  function healInterfaces(type: GraphQLObjectType) {
    updateEachKey(type.getInterfaces(), iface => {
      const healedType = healType(iface);
      return healedType;
    });
  }

  function healInputFields(type: GraphQLInputObjectType) {
    updateEachKey(type.getFields(), field => {
      field.type = healType(field.type);
      return field.type === null ? null : field;
    });
  }

  function healUnderlyingTypes(type: GraphQLUnionType) {
    updateEachKey(type.getTypes(), t => {
      const healedType = healType(t);
      return healedType;
    });
  }

  function healType<T extends GraphQLType>(type: T): T {
    // Unwrap the two known wrapper types
    if (type instanceof GraphQLList) {
      const healedType = healType(type.ofType);
      return healedType ? new GraphQLList(healedType) as T : null;
    } else if (type instanceof GraphQLNonNull) {
      const healedType = healType(type.ofType);
      return healedType ? new GraphQLNonNull(healedType) as T : null;
    } else if (isNamedType(type)) {
      // If a type annotation on a field or an argument or a union member is
      // any `GraphQLNamedType` with a `name`, then it must end up identical
      // to `schema.getType(name)`, since `schema.getTypeMap()` is the source
      // of truth for all named schema types.
      // Note that new types can still be simply added by adding a field, as
      // the official type will be undefined, not null.
      let officialType = originalTypeMap[type.name];
      if (officialType === undefined) {
        if (isStub(type)) {
          officialType = getBuiltInForStub(type);
        } else {
          officialType = type;
        }
        originalTypeMap[type.name] = officialType;
      }
      return officialType as T;
    } else {
      return null;
    }
  }
}

function pruneTypes(typeMap: NamedTypeMap, directives: ReadonlyArray<GraphQLDirective>) {
  const implementedInterfaces = {};
  each(typeMap, (namedType, typeName) => {
    if (namedType instanceof GraphQLObjectType) {
      each(namedType.getInterfaces(), iface => {
        implementedInterfaces[iface.name] = true;
      });
    }
  });

  let prunedTypeMap = false;
  updateEachKey(typeMap, (type, typeName) => {
    let shouldPrune: boolean = false;
    if (type instanceof GraphQLObjectType) {
      // prune types with no fields
      shouldPrune = !Object.keys(type.getFields()).length;
    } else if (type instanceof GraphQLUnionType) {
      // prune unions without underlying types
      shouldPrune = !type.getTypes().length;
    } else if (type instanceof GraphQLInterfaceType) {
      // prune interfaces without fields or without implementations
      shouldPrune = !Object.keys(type.getFields()).length || !implementedInterfaces[type.name];
    }

    if (shouldPrune) {
      prunedTypeMap = true;
      return null;
    }
  });

  // every prune requires another round of healing
  if (prunedTypeMap) {
    healTypes(typeMap, directives);
  }
}
