import {
  GraphQLField,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLType,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLFieldMap,
} from 'graphql';

import {
  IResolvers,
  IResolverValidationOptions,
  IAddResolveFunctionsToSchemaOptions,
} from '../Interfaces';

import SchemaError from './SchemaError';
import checkForResolveTypeResolver from './checkForResolveTypeResolver';
import extendResolversFromInterfaces from './extendResolversFromInterfaces';
import forEachField from './forEachField';
import forEachDefaultValue from './forEachDefaultValue';

import { serializeInputValue, parseInputValue } from '../transformInputValue';
import { healSchema } from '../schemaVisitor';

function addResolveFunctionsToSchema(
  options: IAddResolveFunctionsToSchemaOptions | GraphQLSchema,
  legacyInputResolvers?: IResolvers,
  legacyInputValidationOptions?: IResolverValidationOptions,
) {
  if (options instanceof GraphQLSchema) {
    console.warn(
      'The addResolveFunctionsToSchema function takes named options now; see IAddResolveFunctionsToSchemaOptions',
    );
    options = {
      schema: options,
      resolvers: legacyInputResolvers,
      resolverValidationOptions: legacyInputValidationOptions,
    };
  }

  const {
    schema,
    resolvers: inputResolvers,
    defaultFieldResolver,
    resolverValidationOptions = {},
    inheritResolversFromInterfaces = false,
  } = options;

  const {
    allowResolversNotInSchema = false,
    requireResolversForResolveType,
  } = resolverValidationOptions;

  const resolvers = inheritResolversFromInterfaces
    ? extendResolversFromInterfaces(schema, inputResolvers)
    : inputResolvers;

  // serialize all default values prior to addition of scalar/enum types.
  // default values will be parsed via new defs after addition of the new types.
  forEachDefaultValue(schema, serializeInputValue);

  Object.keys(resolvers).forEach(typeName => {
    const resolverValue = resolvers[typeName];
    const resolverType = typeof resolverValue;

    if (resolverType !== 'object' && resolverType !== 'function') {
      throw new SchemaError(
        `"${typeName}" defined in resolvers, but has invalid value "${resolverValue}". A resolver's value ` +
        `must be of type object or function.`,
      );
    }

    const type = schema.getType(typeName);

    if (!type && typeName !== '__schema') {
      if (allowResolversNotInSchema) {
        return;
      }

      throw new SchemaError(
        `"${typeName}" defined in resolvers, but not in schema`,
      );
    }

    if (type instanceof GraphQLScalarType) {
      Object.keys(resolverValue).forEach(fieldName => {
        // Below is necessary as legacy code for scalar type specification allowed
        // hardcoding within the resolver an object with fields '__serialize',
        // '__parse', and '__parseLiteral', see examples in testMocking.ts.
        if (fieldName.startsWith('__')) {
          type[fieldName.substring(2)] = resolverValue[fieldName];
        } else {
          type[fieldName] = resolverValue[fieldName];
        }
      });
    } else if (type instanceof GraphQLEnumType) {
      // We've encountered an enum resolver that is being used to provide an
      // internal enum value.
      // Reference: https://www.apollographql.com/docs/graphql-tools/scalars.html#internal-values
      Object.keys(resolverValue).forEach(fieldName => {
        if (!type.getValue(fieldName)) {
          if (allowResolversNotInSchema) {
            return;
          }
          throw new SchemaError(
            `${typeName}.${fieldName} was defined in resolvers, but enum is not in schema`,
          );
        }
      });

      const values = type.getValues();
      const newValues = {};
      values.forEach(value => {
        const newValue = Object.keys(resolverValue).includes(
          value.name,
        )
          ? resolverValue[value.name]
          : value.name;
        newValues[value.name] = {
          value: newValue,
          deprecationReason: value.deprecationReason,
          description: value.description,
          astNode: value.astNode,
        };
      });

      const typeMap = schema.getTypeMap();
      // healSchema called later to update fields to new type
      typeMap[type.name] = new GraphQLEnumType({
        name: type.name,
        description: type.description,
        astNode: type.astNode,
        values: newValues,
      });
    } else {
      // object type
      Object.keys(resolverValue).forEach(fieldName => {
        if (fieldName.startsWith('__')) {
          // this is for isTypeOf and resolveType and all the other stuff.
          type[fieldName.substring(2)] = resolverValue[fieldName];
          return;
        }

        const fields = getFieldsForType(type);
        if (!fields) {
          if (allowResolversNotInSchema) {
            return;
          }

          throw new SchemaError(
            `${typeName} was defined in resolvers, but it's not an object`,
          );
        }

        if (!fields[fieldName]) {
          if (allowResolversNotInSchema) {
            return;
          }

          throw new SchemaError(
            `${typeName}.${fieldName} defined in resolvers, but not in schema`,
          );
        }
        const field = fields[fieldName];
        const fieldResolve = resolverValue[fieldName];
        if (typeof fieldResolve === 'function') {
          // for convenience. Allows shorter syntax in resolver definition file
          field.resolve = fieldResolve;
        } else {
          if (typeof fieldResolve !== 'object') {
            throw new SchemaError(
              `Resolver ${typeName}.${fieldName} must be object or function`,
            );
          }
          setFieldProperties(field, fieldResolve);
        }
      });
    }
  });

  checkForResolveTypeResolver(schema, requireResolversForResolveType);

  // schema may have new enum types that require healing
  healSchema(schema);
  // reparse all  default values with new parsing functions.
  forEachDefaultValue(schema, parseInputValue);

  if (defaultFieldResolver) {
    forEachField(schema, field => {
      if (!field.resolve) {
        field.resolve = defaultFieldResolver;
      }
    });
  }

  return schema;
}

function getFieldsForType(type: GraphQLType): GraphQLFieldMap<any, any> {
  if (
    type instanceof GraphQLObjectType ||
    type instanceof GraphQLInterfaceType
  ) {
    return type.getFields();
  } else {
    return undefined;
  }
}

function setFieldProperties(
  field: GraphQLField<any, any>,
  propertiesObj: Object,
) {
  Object.keys(propertiesObj).forEach(propertyName => {
    field[propertyName] = propertiesObj[propertyName];
  });
}

export default addResolveFunctionsToSchema;
