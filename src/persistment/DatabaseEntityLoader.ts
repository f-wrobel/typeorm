import {EntityMetadata} from "../metadata/EntityMetadata";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {Connection} from "../connection/Connection";
import {Subject} from "./subject/Subject";
import {SubjectCollection} from "./subject/SubjectCollection";


// at the end, subjects which does not have database entities are newly persisted entities
// subjects which has both entities and databaseEntities needs to be compared and updated
// subjects which has only database entities should be removed
// is it right?

class LoadEntity {
    constructor(public target: Function|string,
                public mixedId: any) {
    }
}

/**
 * To be able to execute persistence operations we need to load all entities from the database we need.
 * Loading should be efficient - we need to load entities in as few queries as possible + load as less data as we can.
 * This is how we determine which entities needs to be loaded from db:
 *
 * 1. example with cascade updates and inserts:
 *
 * [Y] - means "yes, we load"
 * [N] - means "no, we don't load"
 * in {} braces we specify what cascade options are set between relations
 *
 * if Post is new, author is not set in the post
 *
 * [Y] Post -> {all} // yes because of "update" and "insert" cascades, no because of "remove"
 *   [Y] Author -> {all} // no because author is not set
 *     [Y] Photo -> {all} // no because author and its photo are not set
 *       [Y] Tag -> {all} // no because author and its photo and its tag are not set
 *
 * if Post is new, author is new (or anything else is new)
 * if Post is updated
 * if Post and/or Author are updated
 *
 * [Y] Post -> {all} // yes because of "update" and "insert" cascades, no because of "remove"
 *   [Y] Author -> {all} // yes because of "update" and "insert" cascades, no because of "remove"
 *     [Y] Photo -> {all} // yes because of "update" and "insert" cascades, no because of "remove"
 *       [Y] Tag -> {all} // yes because of "update" and "insert" cascades, no because of "remove"
 *
 * Here we load post, author, photo, tag to check if they are new or not to persist insert or update operation.
 * We load post, author, photo, tag only if they exist in the relation.
 * From these examples we can see that we always load entity relations when it has "update" or "insert" cascades.
 *
 * 2. example with cascade removes
 *
 * if entity is new its remove operations by cascades should not be executed
 * if entity is updated then values that are null or missing in array (not undefined!, undefined means skip - don't do anything) are treated as removed
 * if entity is removed then all its downside relations which has cascade remove should be removed
 *
 * Once we find removed entity - we load it, and every downside entity which has "remove" cascade set.
 *
 * At the end we have all entities we need to operate with.
 * Next step is to store all loaded entities to manipulate them efficiently.
 */
export class DatabaseEntityLoader<Entity extends ObjectLiteral> {

    // -------------------------------------------------------------------------
    // Protected properties
    // -------------------------------------------------------------------------

    private persistedEntity: Subject;
    private loadMap: SubjectCollection = new SubjectCollection();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(protected connection: Connection) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    async load(entity: Entity, metadata: EntityMetadata): Promise<void> {
        this.persistedEntity = new Subject(metadata, entity);
        this.loadMap.push(this.persistedEntity);
        this.findCascadeUpdateAndInsertEntitiesToLoad(entity, metadata);
        await this.populateSubjectCollectionWithDatabaseEntities(this.loadMap);

        const removePopulationPromises = this.loadMap
            .filter(subject => !!subject.databaseEntity) // means we only attempt to load for non new entities
            .map(subject => this.findCascadeRemovedEntitiesToLoad(subject));
        await Promise.all(removePopulationPromises);

        console.log(this.loadMap);
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Extracts all entities that should be loaded from the database.
     * These are only entities with which entity has insert and update cascades.
     * We can't add removed entities here, because to know which entity we need to load we entity id.
     * But in persist entity we don't have entity, thous don't have id.
     * Entity id of the removed entity is stored in the database entity.
     * That's why we first need to load all changed entities,
     * then extract ids of the removed entities from them,
     * and only then load removed entities by extracted ids.
     */
    protected findCascadeUpdateAndInsertEntitiesToLoad(entity: ObjectLiteral, metadata: EntityMetadata): void {
        metadata
            .extractRelationValuesFromEntity(entity, metadata.relations)
            .forEach(([relation, value, valueMetadata]) => {

                // if there is a value in the relation and insert or update cascades are set - it means we must load entity
                if (relation.isEntityDefined(value) && (relation.isCascadeInsert || relation.isCascadeUpdate)) {

                    // add to the array of subjects to load only if there is no same entity there already
                    const subject = new Subject(valueMetadata, value); // todo: store relations inside to create correct order then?
                    this.loadMap.pushIfNotExist(subject);

                    // go recursively and find other entities to load by cascades in currently inserted entities
                    this.findCascadeUpdateAndInsertEntitiesToLoad(value, valueMetadata);

                }
            });
    }

    /**
     * We need to load removed entity when:
     *  - entity with relations is not new (this can be determined only after entity is loaded from db)
     *  - entity missing relation. When relation is simple
     *      - in the case of one-to-one owner (with join column) relation we need to load owner entity
     *      - in the case of one-to-one (without join column) relation we need to load inverse side entity
     *      - in the case of many-to-one relations we need to load entity itself
     *      - in the case of one-to-many relations we need to load entities by relation from inverse side
     *
     *  Before loading each entity we need to check in the loaded subjects - maybe it was already loaded.
     *
     *  BIG NOTE: objects are being removed by cascades not only when relation is removed, but also when
     *  relation is replaced (e.g. changed with different object).
     */
    protected async findCascadeRemovedEntitiesToLoad(subject: Subject/*, forceRemove = false*/): Promise<void> {

        // note: we can't use extractRelationValuesFromEntity here because it does not handle empty arrays
        const promises = subject.metadata.relations.map(async relation => {
            const valueMetadata = relation.inverseEntityMetadata;
            const qbAlias = valueMetadata.table.name;

            // we only need relations that has cascade remove set
            if (!relation.isCascadeRemove) return;

            // todo: added here because of type safety. theoretically it should not be empty, but what to do? throw exception if its empty?
            if (!subject.databaseEntity) return;

            // if this subject is persisted subject then we get its value to check if its not empty or its values changed
            let persistValueRelationId: any = null;
            if (subject.entity) {
                persistValueRelationId = relation.getEntityValue(subject.entity);
                // persistValue = persistValueRelationId; // use it if entity itself is needed
                if (persistValueRelationId) persistValueRelationId = relation.getInverseEntityRelationId(persistValueRelationId);
                if (persistValueRelationId === undefined) return; // skip undefined properties
            }

            // for one-to-one owner and many-to-one relations no need to load entity to check if something removed
            // because join column is in this side of relation and we have a database entity with which we can compare
            // and understand if relation was removed or not
            if (relation.isOneToOneOwner || relation.isManyToOne) { // this indicates that relation value inside object is removed

                /**
                 * By example (one-to-one). Let's say we have a one-to-one relation between Post and Details.
                 * Post contains detailsId. It means he owns relation. Post has cascade remove with details.
                 * Now here we have a post object with removed details.
                 * We need to remove Details if post.details = null
                 * or if post.details != databasePost.details
                 */

                /**
                 * By example (many-to-one). Let's say we have a many-to-one relation between Post and Details.
                 * Post contains detailsId. It means he owns relation.
                 * It also means that post can have only one details, and details can have multiple posts.
                 * Post has cascade remove with details.
                 * Now here we have a post object with removed details.
                 * We need to remove Details (one) if post.details = null
                 * or if post.details != databasePost.details
                 */

                // (example) "relation" - is a relation in post with details.
                // (example) "valueMetadata" - is an entity metadata of the Details object.
                // (example) "persistValue" - is a detailsId from the persisted entity

                // note that if databaseEntity has relation, it can only be a relation id,
                // because of query builder option "RELATION_ID_VALUES" we used
                const relationIdInDatabaseEntity = relation.getOwnEntityRelationId(subject.databaseEntity); // (example) returns post.detailsId

                // if database relation id does not exist in the database object then nothing to remove
                if (relationIdInDatabaseEntity !== null && relationIdInDatabaseEntity !== undefined)
                    return;

                // object is removed only if relation id in the persisted entity is empty or is changed
                if (persistValueRelationId === null || persistValueRelationId === relationIdInDatabaseEntity)
                    return;

                // first check if we already loaded this object before load from the database
                let alreadyLoadedRelatedDatabaseSubject = this.loadMap.find(relatedSubject => {

                    // (example) filter only subject that has database entity loaded and its target is Details
                    if (!relatedSubject.databaseEntity || relatedSubject.entityTarget !== valueMetadata.target)
                        return false;

                    // (example) here we seek a Details loaded from the database in the subjects
                    // (example) here relatedSubject.databaseEntity is a Details
                    // (example) and we need to compare details.id === post.detailsId
                    return relation.getInverseEntityRelationId(relatedSubject.databaseEntity) === relationIdInDatabaseEntity;
                });

                // if not loaded yet then load it from the database
                if (!alreadyLoadedRelatedDatabaseSubject) {

                    // (example) we need to load a details where details.id = post.details
                    const databaseEntity = await this.connection
                        .getRepository<ObjectLiteral>(valueMetadata.target)
                        .createQueryBuilder(qbAlias)
                        .where(qbAlias + "." + relation.joinColumn.referencedColumn.propertyName + "=:id") // todo: need to escape alias and propertyName?
                        .setParameter("id", relation.getOwnEntityRelationId(subject.databaseEntity)) // (example) subject.entity is a post here
                        .enableOption("RELATION_ID_VALUES")
                        .getSingleResult();

                    if (databaseEntity) {
                        alreadyLoadedRelatedDatabaseSubject = new Subject(valueMetadata, undefined, databaseEntity);
                        this.loadMap.push(subject);
                    }
                }

                if (alreadyLoadedRelatedDatabaseSubject) {
                    alreadyLoadedRelatedDatabaseSubject.markedAsRemoved = true;
                    await this.findCascadeRemovedEntitiesToLoad(alreadyLoadedRelatedDatabaseSubject);
                }
            }

            // for one-to-one not owner we need to load entity to understand that it was really removed or not,
            // since column value that indicates relation is stored on inverse side
            // that's why we need to load object and
            if (relation.isOneToOneNotOwner) { // this indicates that relation value inside object is removed

                /**
                 * By example. Let's say we have a one-to-one relation between Post and Details.
                 * Post contains detailsId. It means he owns relation. Details has cascade remove with post.
                 * Now here we have a details object with removed post.
                 * We need to remove Post if details.post = null and databasePost.detailsId = details.id exist in the db,
                 * or if databasePost.id === details.post.id (we need to load it) and databasePost.detailsId != details.id
                 */

                // (example) "relation" - is a relation in details with post.
                // (example) "valueMetadata" - is an entity metadata of the Post object.
                // (example) "subject.databaseEntity" - is a details object

                // note that if databaseEntity has relation, it can only be a relation id,
                // because of query builder option "RELATION_ID_VALUES" we used
                // (example) returns us referenced column (detail's id)
                const relationIdInDatabaseEntity = relation.getOwnEntityRelationId(subject.databaseEntity);

                // if database relation id does not exist then nothing to remove (but can this be possible?)
                if (relationIdInDatabaseEntity !== null && relationIdInDatabaseEntity !== undefined)
                    return;

                // first check if we already have this object loaded before load from the database
                let alreadyLoadedRelatedDatabaseSubject = this.loadMap.find(relatedSubject => {

                    // (example) filter only subject that has database entity loaded and its target is Post
                    if (!relatedSubject.databaseEntity || relatedSubject.entityTarget !== valueMetadata.target)
                        return false;

                    // (example) here we seek a Post loaded from the database in the subjects
                    // (example) here relatedSubject.databaseEntity is a Post
                    // (example) and we need to compare post.detailsId === details.id
                    return relation.getInverseEntityRelationId(relatedSubject.databaseEntity) === relationIdInDatabaseEntity;
                });

                // if not loaded yet then load it from the database
                if (!alreadyLoadedRelatedDatabaseSubject) {

                    // (example) we need to load a post where post.detailsId = details.id
                    const databaseEntity = await this.connection
                        .getRepository<ObjectLiteral>(valueMetadata.target)
                        .createQueryBuilder(qbAlias)
                        .where(qbAlias + "." + relation.inverseSideProperty + "=:id") // todo: need to escape alias and propertyName?
                        .setParameter("id", relation.getOwnEntityRelationId(subject.entity)) // (example) subject.entity is a details here, and the value is details.id
                        .enableOption("RELATION_ID_VALUES")
                        .getSingleResult();

                    // add only if database entity exist - because in the case of inverse side of the one-to-one relation
                    // we cannot check if it was removed or not until we query the database
                    // and it can be a situation that relation wasn't exist at all. This is particular that case
                    if (databaseEntity) {
                        alreadyLoadedRelatedDatabaseSubject = new Subject(valueMetadata, undefined, databaseEntity);
                        this.loadMap.push(subject);
                    }
                }

                // check if we really has a relation between entities. If relation not found then alreadyLoadedRelatedDatabaseSubject will be empty
                if (alreadyLoadedRelatedDatabaseSubject && alreadyLoadedRelatedDatabaseSubject.databaseEntity) {

                    // also check if relation value exist then then make sure its changed
                    // (example) persistValue is a postFromPersistedDetails here
                    // (example) alreadyLoadedRelatedDatabaseSubject.databaseEntity is a postFromDatabaseDetails here
                    // (example) postFromPersistedDetails.id === postFromDatabaseDetails - means nothing changed
                    if (persistValueRelationId && persistValueRelationId ===
                        relation.getInverseEntityRelationId(alreadyLoadedRelatedDatabaseSubject.databaseEntity))
                        return;

                    alreadyLoadedRelatedDatabaseSubject.markedAsRemoved = true;
                    await this.findCascadeRemovedEntitiesToLoad(alreadyLoadedRelatedDatabaseSubject);
                }
            }
        });

        await Promise.all(promises);
    }

    protected async populateSubjectCollectionWithDatabaseEntities(collection: SubjectCollection): Promise<void> {
        const promises = collection
            .groupByEntityTargets()
            .map(subjectGroup => {
                const allIds = subjectGroup.subjects.map(subject => subject.mixedId);
                const metadata = this.connection.getMetadata(subjectGroup.target);
                return this.connection
                    .getRepository<ObjectLiteral>(subjectGroup.target)
                    .findByIds(allIds, { alias: metadata.table.name, enabledOptions: ["RELATION_ID_VALUES"] })
                    .then(entities => {
                        entities.forEach(entity => {
                            const subject = this.loadMap.findByEntityLike(metadata.target, entity);
                            if (subject)
                                subject.databaseEntity = entity;
                        });
                    });
            });

        await Promise.all(promises);
    }

    // protected async

}