import { GraphQLSchema, GraphQLField, defaultFieldResolver } from 'graphql';
import { IDirectiveResolvers } from '../Interfaces';
import { SchemaDirectiveVisitor } from '../utils/SchemaDirectiveVisitor';

function attachDirectiveResolvers(
  schema: GraphQLSchema,
  directiveResolvers: IDirectiveResolvers<any, any>,
) {
  if (typeof directiveResolvers !== 'object') {
    throw new Error(
      `Expected directiveResolvers to be of type object, got ${typeof directiveResolvers}`,
    );
  }

  if (Array.isArray(directiveResolvers)) {
    throw new Error(
      'Expected directiveResolvers to be of type object, got Array',
    );
  }

  const schemaDirectives = Object.create(null);

  Object.keys(directiveResolvers).forEach(directiveName => {
    schemaDirectives[directiveName] = class extends SchemaDirectiveVisitor {
      public visitFieldDefinition(field: GraphQLField<any, any>) {
        const resolver = directiveResolvers[directiveName];
        const originalResolver = field.resolve || defaultFieldResolver;
        const directiveArgs = this.args;
        field.resolve = (...args: any[]) => {
          const [source /* original args */, , context, info] = args;
          return resolver(
            async () => originalResolver.apply(field, args),
            source,
            directiveArgs,
            context,
            info,
          );
        };
      }
    };
  });

  SchemaDirectiveVisitor.visitSchemaDirectives(schema, schemaDirectives);
}

export default attachDirectiveResolvers;
