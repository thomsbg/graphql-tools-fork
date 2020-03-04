import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
  GraphQLType,
} from 'graphql';

import { GraphQLSchemaWithTransforms, VisitSchemaKind } from '../Interfaces';
import { visitSchema, cloneSchema } from '../utils';
import { toConfig } from '../polyfills';

export type RootFieldFilter = (
  operation: 'Query' | 'Mutation' | 'Subscription',
  rootFieldName: string,
) => boolean;

export type FieldFilter = (typeName: string, rootFieldName: string) => boolean;

export default function filterSchema({
  schema,
  rootFieldFilter = () => true,
  typeFilter = () => true,
  fieldFilter = () => true,
}: {
  schema: GraphQLSchemaWithTransforms;
  rootFieldFilter?: RootFieldFilter;
  typeFilter?: (typeName: string, type: GraphQLType) => boolean;
  fieldFilter?: (typeName: string, fieldName: string) => boolean;
}): GraphQLSchemaWithTransforms {
  const filteredSchema: GraphQLSchemaWithTransforms = visitSchema(
    cloneSchema(schema),
    {
      [VisitSchemaKind.QUERY]: (type: GraphQLObjectType) =>
        filterRootFields(type, 'Query', rootFieldFilter),
      [VisitSchemaKind.MUTATION]: (type: GraphQLObjectType) =>
        filterRootFields(type, 'Mutation', rootFieldFilter),
      [VisitSchemaKind.SUBSCRIPTION]: (type: GraphQLObjectType) =>
        filterRootFields(type, 'Subscription', rootFieldFilter),
      [VisitSchemaKind.OBJECT_TYPE]: (type: GraphQLObjectType) =>
        typeFilter(type.name, type)
          ? filterObjectFields(type, fieldFilter)
          : null,
      [VisitSchemaKind.INTERFACE_TYPE]: (type: GraphQLInterfaceType) =>
        typeFilter(type.name, type)
          ? filterInterfaceFields(type, fieldFilter)
          : null,
      [VisitSchemaKind.UNION_TYPE]: (type: GraphQLUnionType) =>
        typeFilter(type.name, type) ? undefined : null,
      [VisitSchemaKind.INPUT_OBJECT_TYPE]: (type: GraphQLInputObjectType) =>
        typeFilter(type.name, type) ? undefined : null,
      [VisitSchemaKind.ENUM_TYPE]: (type: GraphQLEnumType) =>
        typeFilter(type.name, type) ? undefined : null,
      [VisitSchemaKind.SCALAR_TYPE]: (type: GraphQLScalarType) =>
        typeFilter(type.name, type) ? undefined : null,
    },
  );

  filteredSchema.transforms = schema.transforms;

  return filteredSchema;
}

function filterRootFields(
  type: GraphQLObjectType,
  operation: 'Query' | 'Mutation' | 'Subscription',
  rootFieldFilter: RootFieldFilter,
): GraphQLObjectType {
  const config = toConfig(type);
  Object.keys(config.fields).forEach(fieldName => {
    if (!rootFieldFilter(operation, fieldName)) {
      delete config.fields[fieldName];
    }
  });
  return new GraphQLObjectType(config);
}

function filterObjectFields(
  type: GraphQLObjectType,
  fieldFilter: FieldFilter,
): GraphQLObjectType {
  const config = toConfig(type);
  Object.keys(config.fields).forEach(fieldName => {
    if (!fieldFilter(type.name, fieldName)) {
      delete config.fields[fieldName];
    }
  });
  return new GraphQLObjectType(config);
}

function filterInterfaceFields(
  type: GraphQLInterfaceType,
  fieldFilter: FieldFilter
): GraphQLInterfaceType {
  const config = toConfig(type);
  Object.keys(config.fields).forEach(fieldName => {
    if (!fieldFilter(type.name, fieldName)) {
      delete config.fields[fieldName];
    }
  });
  return new GraphQLInterfaceType(config);
}
