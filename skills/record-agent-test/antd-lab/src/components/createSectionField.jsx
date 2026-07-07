// Simplified copy of medallion helpers/createSectionField.tsx — same onboarding
// config semantics (missing key = hidden, false = optional, true = required),
// same "- optional" label suffix, same FieldContext feeding ClearableSelect.
// Dropped: redux auditor check, CASL ability, isExclusiveWith.
import React, { createContext } from 'react';
import { Form } from 'antd';
import { get, isUndefined } from 'lodash';

export const FieldContext = createContext({ isRequired: null });

function onboardingFieldValue({ sectionName, subsectionName, fieldName }, config) {
    if (config === undefined) return undefined;
    const pathString = ['sections', sectionName, subsectionName, fieldName]
        .filter(Boolean)
        .join('.');
    return get(config, pathString);
}

const SectionFieldInner = ({
    _sectionName: sectionName,
    _providerConfig: providerConfig,
    _enforceValidation: enforceValidation,
    _mustBeShown: mustBeShown,
    name,
    configName = null,
    subsectionName = null,
    label,
    children,
    required = true,
    disabled,
    overrideConfig = false,
    additionalRules,
    hideOptionalLabel = false,
    ...props
}) => {
    const fieldName = configName ? configName : name;
    const fieldConfigValue = onboardingFieldValue(
        { sectionName, subsectionName, fieldName },
        providerConfig
    );

    if (isUndefined(fieldConfigValue) && !mustBeShown) return null;
    const isNotHidden = !isUndefined(fieldConfigValue);
    const isRequired = (fieldConfigValue || overrideConfig) && required && isNotHidden;

    return (
        <FieldContext.Provider value={{ isRequired }}>
            <Form.Item
                name={name}
                required={isRequired}
                rules={[
                    { required: enforceValidation && isRequired },
                    ...(additionalRules || []),
                ]}
                label={
                    label && (
                        <span>
                            {label}{' '}
                            {!isRequired && !hideOptionalLabel && (
                                <span style={{ color: '#6C6C74', fontStyle: 'italic' }}>
                                    - optional
                                </span>
                            )}
                        </span>
                    )
                }
                {...props}
            >
                {React.cloneElement(children, { disabled })}
            </Form.Item>
        </FieldContext.Provider>
    );
};

const createSectionField = (sectionName, providerConfig, enforceValidation) => {
    return (fieldProps) => (
        <SectionFieldInner
            _sectionName={sectionName}
            _providerConfig={providerConfig}
            _enforceValidation={enforceValidation}
            {...fieldProps}
        />
    );
};

export default createSectionField;
