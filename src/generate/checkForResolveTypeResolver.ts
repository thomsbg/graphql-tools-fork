import SchemaError from './SchemaError';

import { GraphQLInterfaceType, GraphQLUnionType, GraphQLSchema } from 'graphql';

// If we have any union or interface types throw if no there is no resolveType or isTypeOf resolvers
function checkForResolveTypeResolver(
  schema: GraphQLSchema,
  requireResolversForResolveType?: boolean,
) {
  Object.keys(schema.getTypeMap())
    .map(typeName => schema.getType(typeName))
    .forEach((type: GraphQLUnionType | GraphQLInterfaceType) => {
      if (
        !(
          type instanceof GraphQLUnionType ||
          type instanceof GraphQLInterfaceType
        )
      ) {
        return;
      }
      if (!type.resolveType) {
        if (!requireResolversForResolveType) {
          return;
        }
        throw new SchemaError(
          `Type "${
            type.name
          }" is missing a "__resolveType" resolver. Pass false into `  +
          '"resolverValidationOptions.requireResolversForResolveType" to disable this error.',
        );
      }
    });
}
export default checkForResolveTypeResolver;
