import forOwn from 'lodash/object/forOwn';
import find from 'lodash/collection/find';
import Session from './Session';
import Model from './Model';
import {ForeignKey, ManyToMany, OneToOne} from './fields';
import {
    forwardManyToOneDescriptor,
    backwardManyToOneDescriptor,
    forwardOneToOneDescriptor,
    backwardOneToOneDescriptor,
    manyToManyDescriptor,
} from './descriptors';

import {
    m2mName,
    attachQuerySetMethods,
    m2mToFieldName,
    m2mFromFieldName,
    reverseFieldName,
} from './utils';


/**
 * Schema's responsibility is tracking the set of {@link Model} classes used in the database.
 * To include your model in that set, Schema offers {@link Schema#register} and a
 * shortcut {@link Schema#define} methods.
 *
 * Schema also handles starting a Session with {@link Schema#from}.
 */
const Schema = class Schema {
    /**
     * Creates a new Schema.
     */
    constructor() {
        this.registry = [];
        this.implicitThroughModels = [];
    }

    /**
     * Defines a Model class with the provided options and registers
     * it to the schema instance.
     *
     * Note that you can also define Model classes by yourself
     * with ES6 classes.
     *
     * @param  {string} modelName - the name of the model class
     * @param  {Object} [relatedFields] - a dictionary of `fieldName: fieldInstance`
     * @param  {Function} [reducer] - the reducer function to use for this model
     * @param  {Object} [backendOpts] -Backend options for this model.
     * @return {Model} The defined model class.
     */
    define(modelName, relatedFields, reducer, backendOpts) {
        class ShortcutDefinedModel extends Model {}
        ShortcutDefinedModel.modelName = modelName;
        ShortcutDefinedModel.backend = backendOpts;
        ShortcutDefinedModel.fields = relatedFields;

        if (typeof reducer === 'function') {
            ShortcutDefinedModel.reducer = reducer;
        }

        this.register(ShortcutDefinedModel);

        return ShortcutDefinedModel;
    }

    /**
     * Sets a reducer function to the model with `modelName`.
     * @param {string} modelName - The name of the model you want to set a reducer to
     * @param {Function} reducer - The reducer function.
     */
    setReducer(modelName, reducer) {
        const model = this.get(modelName);
        model.reducer = reducer;
    }

    /**
     * Registers a model class to the schema.
     *
     * If the model has declared any ManyToMany fields, their
     * through models will be generated and registered with
     * this call.
     *
     * @param  {...Model} model - a model to register
     * @return {undefined}
     */
    register() {
        const models = Array.prototype.slice.call(arguments);
        models.forEach(model => {
            model.invalidateCaches();

            this.registerManyToManyModelsFor(model);
            this.registry.push(model);
        });
    }

    registerManyToManyModelsFor(model) {
        const fields = model.fields;
        const thisModelName = model.modelName;

        forOwn(fields, (fieldInstance, fieldName) => {
            if (fieldInstance instanceof ManyToMany) {
                let toModelName;
                if (fieldInstance.toModelName === 'this') {
                    toModelName = thisModelName;
                } else {
                    toModelName = fieldInstance.toModelName;
                }

                const fromFieldName = m2mFromFieldName(thisModelName);
                const toFieldName = m2mToFieldName(toModelName);

                const Through = class ThroughModel extends Model {};

                Through.modelName = m2mName(thisModelName, fieldName);

                Through.fields = {
                    [fromFieldName]: new ForeignKey(thisModelName),
                    [toFieldName]: new ForeignKey(toModelName),
                };

                Through.invalidateCaches();
                this.implicitThroughModels.push(Through);
            }
        });
    }

    /**
     * Gets a model by its name from the registry.
     * @param  {string} modelName - the name of the model to get
     * @throws If model is not found.
     * @return {Model} the model class, if found
     */
    get(modelName) {
        const found = find(this.registry.concat(this.implicitThroughModels), (model) => model.modelName === modelName);
        if (typeof found === 'undefined') {
            throw new Error(`Did not find model ${modelName} from registry.`);
        }
        return found;
    }

    getModelClasses() {
        this.setupModelPrototypes();
        return this.registry.concat(this.implicitThroughModels);
    }

    _attachQuerySetMethods(model) {
        const {querySetClass} = model;
        attachQuerySetMethods(model, querySetClass);
    }

    setupModelPrototypes() {
        this.registry.forEach(model => {
            if (!model._setupDone) {
                const fields = model.fields;
                forOwn(fields, (fieldInstance, fieldName) => {
                    const toModelName = fieldInstance.toModelName;
                    const toModel = toModelName === 'this' ? model : this.get(toModelName);

                    if (fieldInstance instanceof ForeignKey) {
                        // Forwards.
                        Object.defineProperty(
                            model.prototype,
                            fieldName,
                            forwardManyToOneDescriptor(fieldName, toModel)
                        );
                        model.definedProperties[fieldName] = true;

                        // Backwards.
                        const backwardsFieldName = reverseFieldName(model.modelName);
                        Object.defineProperty(
                            toModel.prototype,
                            backwardsFieldName,
                            backwardManyToOneDescriptor(fieldName, model)
                        );
                        toModel.definedProperties[backwardsFieldName] = true;
                    } else if (fieldInstance instanceof ManyToMany) {
                        // Forwards.
                        const throughModelName = m2mName(model.modelName, fieldName);
                        const throughModel = this.get(throughModelName);

                        Object.defineProperty(
                            model.prototype,
                            fieldName,
                            manyToManyDescriptor(model, toModel, throughModel, false)
                        );
                        model.definedProperties[fieldName] = true;

                        // Backwards.
                        const backwardsFieldName = reverseFieldName(model.modelName);
                        Object.defineProperty(
                            toModel.prototype,
                            backwardsFieldName,
                            manyToManyDescriptor(model, toModel, throughModel, true)
                        );
                        toModel.definedProperties[backwardsFieldName] = true;
                    } else if (fieldInstance instanceof OneToOne) {
                        // Forwards.
                        Object.defineProperty(
                            model.prototype,
                            fieldName,
                            forwardOneToOneDescriptor(fieldName, toModel)
                        );
                        model.definedProperties[fieldName] = true;

                        // Backwards.
                        const backwardsFieldName = model.modelName.toLowerCase();
                        Object.defineProperty(
                            toModel.prototype,
                            backwardsFieldName,
                            backwardOneToOneDescriptor(fieldName, model)
                        );
                        model.definedProperties[backwardsFieldName] = true;
                    }
                });
                this._attachQuerySetMethods(model);
                model._setupDone = true;
            }
        });

        this.implicitThroughModels.forEach(model => {
            if (!model._setupDone) {
                forOwn(model.fields, (fieldInstance, fieldName) => {
                    const toModelName = fieldInstance.toModelName;
                    const toModel = toModelName === 'this' ? model : this.get(toModelName);
                    // Only Forwards.
                    Object.defineProperty(
                        model.prototype,
                        fieldName,
                        forwardManyToOneDescriptor(fieldName, toModel)
                    );
                    model.definedProperties[fieldName] = true;
                });
                this._attachQuerySetMethods(model);
                model._setupDone = true;
            }
        });
    }

    fromEmpty(action) {
        return new Session(this.getModelClasses(), this.getDefaultState(), action);
    }

    /**
     * Begins a database {@link Session}.
     *
     * @param  {Object} state  - the state the database manages
     * @param  {Object} action - the dispatched action object
     * @return {Session} a new session instance
     */
    from(state, action) {
        return new Session(this.getModelClasses(), state, action);
    }

    /**
     * Returns a reducer function you can plug into your own
     * reducer. One way to do that is to declare your root reducer:
     *
     * ```javascript
     * function rootReducer(state, action) {
     *     return {
     *         entities: schema.reducer(),
     *         // Any other reducers you use.
     *     }
     * }
     * ```
     *
     * @return {Function} a reducer function that creates a new {@link Session} on
     *                    each action dispatch.
     */
    reducer() {
        return (state, action) => {
            return this.from(state, action).reduce();
        };
    }
};

export default Schema;