import {
  DocumentNode,
  GraphQLSchema,
  GraphQLType,
  Kind,
  SelectionSetNode,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { Request, MergedTypeMapping } from '../Interfaces';
import { Transform } from './transforms';

export default class AddMergedTypeFragments implements Transform {
  private targetSchema: GraphQLSchema;
  private mapping: MergedTypeMapping;

  constructor(
    targetSchema: GraphQLSchema,
    mapping: MergedTypeMapping,
  ) {
    this.targetSchema = targetSchema;
    this.mapping = mapping;
  }

  public transformRequest(originalRequest: Request): Request {
    const document = addMergedTypeFragments(
      this.targetSchema,
      originalRequest.document,
      this.mapping,
    );
    return {
      ...originalRequest,
      document,
    };
  }
}

function addMergedTypeFragments(
  targetSchema: GraphQLSchema,
  document: DocumentNode,
  mapping: MergedTypeMapping,
): DocumentNode {
  const typeInfo = new TypeInfo(targetSchema);
  return visit(
    document,
    visitWithTypeInfo(typeInfo, {
      leave: {
        [Kind.SELECTION_SET](
          node: SelectionSetNode,
        ): SelectionSetNode | null | undefined {
          const parentType: GraphQLType = typeInfo.getParentType();
          if (parentType) {
            const parentTypeName = parentType.name;
            let selections = node.selections;

            if (mapping[parentTypeName]) {
              selections = selections.concat(mapping[parentTypeName].fragment);
            }

            if (selections !== node.selections) {
              return {
                ...node,
                selections,
              };
            }
          }
        },
      },
    }),
  );
}
