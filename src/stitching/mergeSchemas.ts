import {
  DocumentNode,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  extendSchema,
  getNamedType,
  isNamedType,
  parse,
  Kind,
  GraphQLDirective,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import {
  IDelegateToSchemaOptions,
  MergeInfo,
  OnTypeConflict,
  IResolversParameter,
  isSubschemaConfig,
  SchemaLikeObject,
  IResolvers,
  SubschemaConfig,
  IGraphQLToolsResolveInfo,
} from '../Interfaces';
import {
  extractExtensionDefinitions,
  addResolversToSchema,
} from '../makeExecutableSchema';
import delegateToSchema from './delegateToSchema';
import typeFromAST from './typeFromAST';
import {
  Transform,
  ExpandAbstractTypes,
  wrapSchema,
  AddReplacementFragments,
} from '../transforms';
import {
  SchemaDirectiveVisitor,
  cloneDirective,
  healSchema,
  healTypes,
  forEachField,
  mergeDeep,
  parseFragmentToInlineFragment,
  concatInlineFragments,
  typeContainsSelectionSet,
  parseSelectionSet,
} from '../utils';
import { TypeMap } from 'graphql/type/schema';

type MergeTypeCandidate = {
  type: GraphQLNamedType;
  schema?: GraphQLSchema;
  subschema?: GraphQLSchema | SubschemaConfig;
  transformedSubschema?: GraphQLSchema;
};

type CandidateSelector = (
  candidates: Array<MergeTypeCandidate>,
) => MergeTypeCandidate;

export default function mergeSchemas({
  subschemas = [],
  types = [],
  typeDefs,
  schemas: schemaLikeObjects = [],
  onTypeConflict,
  resolvers = {},
  schemaDirectives,
  inheritResolversFromInterfaces,
  mergeDirectives,
}: {
  subschemas?: Array<GraphQLSchema | SubschemaConfig>;
  types?: Array<GraphQLNamedType>;
  typeDefs?: string | DocumentNode;
  schemas?: Array<SchemaLikeObject>;
  onTypeConflict?: OnTypeConflict;
  resolvers?: IResolversParameter;
  schemaDirectives?: { [name: string]: typeof SchemaDirectiveVisitor };
  inheritResolversFromInterfaces?: boolean;
  mergeDirectives?: boolean,
}): GraphQLSchema {
  const allSchemas: Array<GraphQLSchema> = [];
  const typeCandidates: { [name: string]: Array<MergeTypeCandidate> } = {};
  const typeMap: { [name: string]: GraphQLNamedType } = {};
  const extensions: Array<DocumentNode> = [];
  const directives: Array<GraphQLDirective> = [];

  let schemas: Array<SchemaLikeObject> = [...subschemas];
  if (typeDefs) {
    schemas.push(typeDefs);
  }
  if (types) {
    schemas.push(types);
  }
  schemas = [...schemas, ...schemaLikeObjects];

  schemas.forEach(schemaLikeObject => {
    if (schemaLikeObject instanceof GraphQLSchema || isSubschemaConfig(schemaLikeObject)) {
      const schema = wrapSchema(schemaLikeObject);

      allSchemas.push(schema);

      const operationTypes = {
        Query: schema.getQueryType(),
        Mutation: schema.getMutationType(),
        Subscription: schema.getSubscriptionType(),
      };

      Object.keys(operationTypes).forEach(typeName => {
        if (operationTypes[typeName]) {
          addTypeCandidate(typeCandidates, typeName, {
            schema,
            type: operationTypes[typeName],
            subschema: schemaLikeObject,
            transformedSubschema: schema,
          });
        }
      });

      if (mergeDirectives) {
        const directiveInstances = schema.getDirectives();
        directiveInstances.forEach(directive => {
          directives.push(directive);
        });
      }

      const originalTypeMap = schema.getTypeMap();
      Object.keys(originalTypeMap).forEach(typeName => {
        const type: GraphQLNamedType = originalTypeMap[typeName];
        if (
          isNamedType(type) &&
          getNamedType(type).name.slice(0, 2) !== '__' &&
          type !== operationTypes.Query &&
          type !== operationTypes.Mutation &&
          type !== operationTypes.Subscription
        ) {
          addTypeCandidate(typeCandidates, type.name, {
            schema,
            type,
            subschema: schemaLikeObject,
            transformedSubschema: schema,
          });
        }
      });
    } else if (
      typeof schemaLikeObject === 'string' ||
      (schemaLikeObject && (schemaLikeObject as DocumentNode).kind === Kind.DOCUMENT)
    ) {
      let parsedSchemaDocument =
        typeof schemaLikeObject === 'string' ? parse(schemaLikeObject) : (schemaLikeObject as DocumentNode);
      parsedSchemaDocument.definitions.forEach(def => {
        const type = typeFromAST(def);
        if (type instanceof GraphQLDirective && mergeDirectives) {
          directives.push(type);
        } else if (type && !(type instanceof GraphQLDirective)) {
          addTypeCandidate(typeCandidates, type.name, {
            type,
          });
        }
      });

      const extensionsDocument = extractExtensionDefinitions(
        parsedSchemaDocument,
      );
      if (extensionsDocument.definitions.length > 0) {
        extensions.push(extensionsDocument);
      }
    } else if (Array.isArray(schemaLikeObject)) {
      schemaLikeObject.forEach(type => {
        addTypeCandidate(typeCandidates, type.name, {
          type,
        });
      });
    } else {
      throw new Error(`Invalid schema passed`);
    }
  });

  let mergeInfo = createMergeInfo(allSchemas, typeCandidates);

  if (typeof resolvers === 'function') {
    console.warn(
      'Passing functions as resolver parameter is deprecated. Use `info.mergeInfo` instead.',
    );
    resolvers = resolvers(mergeInfo) || {};
  } else if (Array.isArray(resolvers)) {
    resolvers = resolvers.reduce((left, right) => {
      if (typeof right === 'function') {
        console.warn(
          'Passing functions as resolver parameter is deprecated. Use `info.mergeInfo` instead.',
        );
        right = right(mergeInfo);
      }
      return mergeDeep(left, right);
    }, {}) || {};
    if (!resolvers) {
      resolvers = {};
    } else if (Array.isArray(resolvers)) {
      resolvers = resolvers.reduce(mergeDeep, {});
    }
  }

  mergeInfo = completeMergeInfo(mergeInfo, resolvers);

  Object.keys(typeCandidates).forEach(typeName => {
    if (
      typeName === 'Query' ||
      typeName === 'Mutation' ||
      typeName === 'Subscription' ||
      mergeInfo.mergedTypes[typeName]
    ) {
      typeMap[typeName] = mergeFields(typeName, typeCandidates[typeName]);
    } else {
      const candidateSelector = onTypeConflict ?
        onTypeConflictToCandidateSelector(onTypeConflict) :
        (cands: Array<MergeTypeCandidate>) => cands[cands.length - 1];
      typeMap[typeName] = candidateSelector(typeCandidates[typeName]).type;
    }
  });

  healTypes(typeMap, directives, { skipPruning: true });

  let mergedSchema = new GraphQLSchema({
    query: typeMap.Query as GraphQLObjectType,
    mutation: typeMap.Mutation as GraphQLObjectType,
    subscription: typeMap.Subscription as GraphQLObjectType,
    types: Object.keys(typeMap).map(key => typeMap[key]),
    directives: directives.length ?
      directives.map((directive) => cloneDirective(directive)) :
      undefined
  });

  extensions.forEach(extension => {
    mergedSchema = (extendSchema as any)(mergedSchema, extension, {
      commentDescriptions: true,
    });
  });

  addResolversToSchema({
    schema: mergedSchema,
    resolvers: resolvers as IResolvers,
    inheritResolversFromInterfaces
  });

  forEachField(mergedSchema, field => {
    if (field.resolve) {
      const fieldResolver = field.resolve;
      field.resolve = (parent, args, context, info) => {
        const newInfo = { ...info, mergeInfo };
        return fieldResolver(parent, args, context, newInfo);
      };
    }
    if (field.subscribe) {
      const fieldResolver = field.subscribe;
      field.subscribe = (parent, args, context, info) => {
        const newInfo = { ...info, mergeInfo };
        return fieldResolver(parent, args, context, newInfo);
      };
    }
  });

  if (schemaDirectives) {
    SchemaDirectiveVisitor.visitSchemaDirectives(
      mergedSchema,
      schemaDirectives,
    );
  }

  healSchema(mergedSchema);

  return mergedSchema;
}

function createMergeInfo(
  allSchemas: Array<GraphQLSchema>,
  typeCandidates: { [name: string]: Array<MergeTypeCandidate> },
): MergeInfo {
  const mergedTypes = {};

  Object.keys(typeCandidates).forEach(typeName => {
    const mergedTypeCandidates =
      typeCandidates[typeName]
        .filter(typeCandidate =>
          typeCandidate.subschema &&
          isSubschemaConfig(typeCandidate.subschema) &&
          typeCandidate.subschema.merge &&
          typeCandidate.subschema.merge[typeName]
        );

    if (mergedTypeCandidates.length) {
      const subschemas: Array<SubschemaConfig> = [];
      let requiredSelections: Array<SelectionNode> = [];
      const fields = Object.create({});
      const typeMaps: Map<SubschemaConfig, TypeMap> = new Map();
      const selectionSets: Map<SubschemaConfig, SelectionSetNode> = new Map();

      mergedTypeCandidates.forEach(typeCandidate => {
        const subschemaConfig = typeCandidate.subschema as SubschemaConfig;
        const transformedSubschema = typeCandidate.transformedSubschema;
        typeMaps.set(subschemaConfig, transformedSubschema.getTypeMap());
        const type = transformedSubschema.getType(typeName) as GraphQLObjectType;
        const fieldMap = type.getFields();
        Object.keys(fieldMap).forEach(fieldName => {
          fields[fieldName] = fields[fieldName] || [];
          fields[fieldName].push(subschemaConfig);
        });

        const mergedTypeConfig = subschemaConfig.merge[typeName];

        if (mergedTypeConfig.selectionSet) {
          const selectionSet = parseSelectionSet(mergedTypeConfig.selectionSet);
          requiredSelections = requiredSelections.concat(selectionSet.selections);
          selectionSets.set(subschemaConfig, selectionSet);
        }

        if (!mergedTypeConfig.resolve) {
          mergedTypeConfig.resolve = (originalResult, context, info, subschema, selectionSet) => delegateToSchema({
            schema: subschema,
            operation: 'query',
            fieldName: mergedTypeConfig.fieldName,
            args: mergedTypeConfig.args(originalResult),
            selectionSet,
            context,
            info,
            skipTypeMerging: true,
          });
        }

        subschemas.push(subschemaConfig);
      });

      mergedTypes[typeName] = {
        subschemas,
        typeMaps,
        selectionSets,
        containsSelectionSet: new Map(),
        uniqueFields: Object.create({}),
        nonUniqueFields: Object.create({}),
      };

      subschemas.forEach(subschema => {
        const type = typeMaps.get(subschema)[typeName] as GraphQLObjectType<any, any>;
        let subschemaMap = new Map();
        subschemas.filter(s => s !== subschema).forEach(s => {
          const selectionSet = selectionSets.get(s);
          if (selectionSet && typeContainsSelectionSet(type, selectionSet)) {
            subschemaMap.set(selectionSet, true);
          }
        });
        mergedTypes[typeName].containsSelectionSet.set(subschema, subschemaMap);
      });

      Object.keys(fields).forEach(fieldName => {
        const supportedBySubschemas = fields[fieldName];
        if (supportedBySubschemas.length === 1) {
          mergedTypes[typeName].uniqueFields[fieldName] = supportedBySubschemas[0];
        } else {
          mergedTypes[typeName].nonUniqueFields[fieldName] = supportedBySubschemas;
        }
      });

      requiredSelections.push(parseSelectionSet(`{ __typename }`).selections[0]);
      mergedTypes[typeName].selectionSet = {
        kind: Kind.SELECTION_SET,
        selections: requiredSelections,
      };
    }
  });

  return {
    delegate(
      operation: 'query' | 'mutation' | 'subscription',
      fieldName: string,
      args: { [key: string]: any },
      context: { [key: string]: any },
      info: IGraphQLToolsResolveInfo,
      transforms?: Array<Transform>,
    ) {
      console.warn(
        '`mergeInfo.delegate` is deprecated. ' +
          'Use `mergeInfo.delegateToSchema and pass explicit schema instances.',
      );
      const schema = guessSchemaByRootField(allSchemas, operation, fieldName);
      const expandTransforms = new ExpandAbstractTypes(info.schema, schema);
      const fragmentTransform = new AddReplacementFragments(schema, info.mergeInfo.replacementFragments);
      return delegateToSchema({
        schema,
        operation,
        fieldName,
        args,
        context,
        info,
        transforms: [
          ...(transforms || []),
          expandTransforms,
          fragmentTransform,
        ],
      });
    },

    delegateToSchema(options: IDelegateToSchemaOptions) {
      return delegateToSchema({
        ...options,
        transforms: options.transforms
      });
    },
    fragments: [],
    replacementSelectionSets: undefined,
    replacementFragments: undefined,
    mergedTypes,
  };
}

function completeMergeInfo(
  mergeInfo: MergeInfo,
  resolvers: IResolversParameter,
): MergeInfo {
  const replacementSelectionSets = Object.create(null);

  Object.keys(resolvers).forEach(typeName => {
    const type = resolvers[typeName];
    if (type instanceof GraphQLScalarType) {
      return;
    }
    Object.keys(type).forEach(fieldName => {
      const field = type[fieldName];
      if (field.selectionSet) {
        const selectionSet = parseSelectionSet(field.selectionSet);
        replacementSelectionSets[typeName] = replacementSelectionSets[typeName] || {};
        replacementSelectionSets[typeName][fieldName] = replacementSelectionSets[typeName][fieldName] || {
          kind: Kind.SELECTION_SET,
          selections: [],
        };
        replacementSelectionSets[typeName][fieldName].selections =
          replacementSelectionSets[typeName][fieldName].selections.concat(selectionSet.selections);
      }
      if (field.fragment) {
        mergeInfo.fragments.push({
          field: fieldName,
          fragment: field.fragment,
        });
      }
    });
  });

  const mapping = {};
  mergeInfo.fragments.forEach(({ field, fragment }) => {
    const parsedFragment = parseFragmentToInlineFragment(fragment);
    const actualTypeName = parsedFragment.typeCondition.name.value;
    mapping[actualTypeName] = mapping[actualTypeName] || {};
    mapping[actualTypeName][field] = mapping[actualTypeName][field] || [];
    mapping[actualTypeName][field].push(parsedFragment);
  });

  const replacementFragments = Object.create(null);
  Object.keys(mapping).forEach(typeName => {
    Object.keys(mapping[typeName]).forEach(field => {
      replacementFragments[typeName] = mapping[typeName] || {};
      replacementFragments[typeName][field] = concatInlineFragments(
        typeName,
        mapping[typeName][field],
      );
    });
  });

  mergeInfo.replacementSelectionSets = replacementSelectionSets;
  mergeInfo.replacementFragments = replacementFragments;

  return mergeInfo;
}

function guessSchemaByRootField(
  schemas: Array<GraphQLSchema>,
  operation: 'query' | 'mutation' | 'subscription',
  fieldName: string,
): GraphQLSchema {
  for (const schema of schemas) {
    let rootObject = operationToRootType(operation, schema);
    if (rootObject) {
      const fields = rootObject.getFields();
      if (fields[fieldName]) {
        return schema;
      }
    }
  }
  throw new Error(
    `Could not find subschema with field \`${operation}.${fieldName}\``,
  );
}

function addTypeCandidate(
  typeCandidates: { [name: string]: Array<MergeTypeCandidate> },
  name: string,
  typeCandidate: MergeTypeCandidate,
) {
  if (!typeCandidates[name]) {
    typeCandidates[name] = [];
  }
  typeCandidates[name].push(typeCandidate);
}

function onTypeConflictToCandidateSelector(onTypeConflict: OnTypeConflict): CandidateSelector {
  return cands =>
    cands.reduce((prev, next) => {
      const type = onTypeConflict(prev.type, next.type, {
        left: {
          schema: prev.schema,
        },
        right: {
          schema: next.schema,
        },
      });
      if (prev.type === type) {
        return prev;
      } else if (next.type === type) {
        return next;
      } else {
        return {
          schemaName: 'unknown',
          type
        };
      }
    });
}

function operationToRootType(
  operation: 'query' | 'mutation' | 'subscription',
  schema: GraphQLSchema,
): GraphQLObjectType {
  if (operation === 'subscription') {
    return schema.getSubscriptionType();
  } else if (operation === 'mutation') {
    return schema.getMutationType();
  } else {
    return schema.getQueryType();
  }
}

function mergeFields(typeName: string, candidates: Array<MergeTypeCandidate>): GraphQLNamedType {
  return new GraphQLObjectType({
    name: typeName,
    fields: candidates.reduce((acc, candidate) => ({
      ...acc,
      ...(candidate.type as GraphQLObjectType).toConfig().fields,
    }), {}),
  });
}
