// Replica of medallion frontend_service/src/pages/Provider/StepEducation/MedicalProgramModal.jsx
// on the same antd 4.24 widgets. Deviations from the original, all non-widget:
//   - redux store / react-query → static providerConfig + local state + onSubmit prop
//   - InstitutionAutocomplete / SpecialtyAutocomplete → antd AutoComplete with static
//     hits (same portal-dropdown widget, no API)
//   - AddressInput (Google Places) → plain Input
//   - UploadButton/FileCard (ECFMG branch) → stub button
//   - useFormModalCancel dirty-check → plain cancel
// Form name, field names, ids, labels, and the conditional-field logic
// (completed_program / program_incompletion_reason / is_present / country=US)
// are kept identical — the input ids are the same onboarding-education_* ones
// the real app renders.
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
    Select,
    Form,
    Modal,
    Input,
    Checkbox,
    Button,
    Divider,
    Typography,
    Row,
    Col,
    Radio,
    notification,
    Tooltip,
    AutoComplete,
} from 'antd';
import { InfoCircleOutlined, PlusCircleOutlined, CloseOutlined } from '@ant-design/icons';
import { isBefore } from 'date-fns';
import states from './constants/states.json';
import medicalPrograms from './constants/medical_program.json';
import medicalProgramIncompleteReason from './constants/medical_program_incomplete_reason.json';
import degrees from './constants/degree.json';
import countries from './constants/country.json';
import {
    getConstantLabelOld,
    getMedicalProgramKinds,
    endDateDisabled,
    startDateDisabled,
    getEndDateValidator,
} from './helpers';
import createSectionField from './components/createSectionField';
import DatePicker from './components/DatePicker';
import ClearableSelect from './components/ClearableSelect';
import MaskedInput, { USPostalCodeInput } from './components/MaskedInput';

const { Paragraph, Text } = Typography;

const minDate = new Date(1920, 1, 1);

const MEDICAL_PROGRAM_KINDS = getMedicalProgramKinds();

const KIND_TO_LABEL = {
    work: 'Work Experience',
    training: 'Training',
    education: 'Education',
};

// Static stand-in for /api/v2/providers/<id>/onboarding. Semantics per
// createSectionField: missing = hidden, false = optional, true = required.
const PROVIDER_CONFIG = {
    id: 'antd-lab',
    sections: {
        education: {
            medical_programs: {
                program_type: true,
                institution_name: true,
                degree_earned: false,
                title: true,
                is_present: false,
                medical_program_start_date: true,
                medical_program_end_date: true,
                completed_program: true,
                program_incompletion_reason: true,
                notes: false,
                medical_program_line_1: false,
                medical_program_line_2: false,
                medical_program_city: true,
                medical_program_state: false,
                medical_program_country: true,
                medical_program_postal_code: false,
                medical_program_phone_number: false,
                ecfmg_identifier: true,
                medical_program_ecfmg_certificate: true,
            },
        },
    },
};

const PROVIDER = { profession: 'MD' };

const INSTITUTION_HITS = [
    { name: 'Stanford University', address: '450 Serra Mall', address_2: '', state: 'CA', city: 'Stanford', country: 'US', zip: '94305' },
    { name: 'Johns Hopkins University', address: '3400 N Charles St', address_2: '', state: 'MD', city: 'Baltimore', country: 'US', zip: '21218' },
    { name: 'University of Michigan', address: '500 S State St', address_2: '', state: 'MI', city: 'Ann Arbor', country: 'US', zip: '48109' },
    { name: 'Karolinska Institutet', address: 'Solnavägen 1', address_2: '', state: '', city: 'Solna', country: 'SE', zip: '17177' },
];

const InstitutionAutocomplete = ({ onSelect, disabled, ...props }) => (
    <AutoComplete
        {...props}
        disabled={disabled}
        placeholder="Institution name"
        options={INSTITUTION_HITS.map((hit) => ({ value: hit.name, label: hit.name }))}
        filterOption={(input, option) =>
            option.value.toLowerCase().includes(input.toLowerCase())
        }
        onSelect={(value) => {
            const hit = INSTITUTION_HITS.find((h) => h.name === value);
            if (hit) onSelect?.(hit);
        }}
    />
);

const SPECIALTIES = ['Cardiology', 'Dermatology', 'Family Medicine', 'Pediatrics'];

const SpecialtyAutocomplete = (props) => (
    <AutoComplete
        {...props}
        placeholder="Specialty"
        options={SPECIALTIES.map((s) => ({ value: s, label: s }))}
        filterOption={(input, option) =>
            option.value.toLowerCase().includes(input.toLowerCase())
        }
    />
);

const emptyContact = {
    id: null,
    first_name: '',
    last_name: '',
    email: '',
    phone_number: '',
};

const prepareFormValues = ({
    end_date,
    ecfmg_certificate,
    program_incompletion_reason,
    ...fieldValues
}) => ({
    ...fieldValues,
    end_date: fieldValues.is_present ? null : end_date,
    program_incompletion_reason: fieldValues.completed_program
        ? ''
        : program_incompletion_reason,
    contacts: fieldValues?.contacts?.filter((item) => item.first_name || item.email) || [],
});

const MedicalProgramModal = (props) => {
    const isStaffOrBPO = true;
    const isAuditor = false;
    const [selectedEventType, setSelectedEventType] = useState(props.kind);
    const [form] = Form.useForm();

    const handleCancel = () => {
        setSelectedEventType(undefined);
        if (props.onCancel) {
            props.onCancel();
        }
    };

    useEffect(() => {
        setSelectedEventType(props.kind);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props]);

    return (
        <Modal
            className="medical-program-modal"
            title={`${props.programData?.id ? 'Update' : 'Add an Event:'} ${
                KIND_TO_LABEL[selectedEventType]
            }`}
            visible={props.visible}
            bodyStyle={{ overflowY: 'scroll', maxHeight: 'calc(100vh - 250px)' }}
            onCancel={handleCancel}
            maskClosable={isStaffOrBPO}
            keyboard={isStaffOrBPO}
            width={600}
            footer={false}
            destroyOnClose
        >
            <div className="ant-form-item">
                <div className="form-item-label">Event Type</div>
                <Select
                    disabled={props.programData?.id || isAuditor}
                    value={selectedEventType}
                    onChange={(value) => setSelectedEventType(value)}
                    style={{ paddingBottom: 5, width: '100%' }}
                    showSearch
                    placeholder="Select..."
                    optionFilterProp="label"
                    options={MEDICAL_PROGRAM_KINDS.map((kind) => ({
                        value: kind,
                        label: KIND_TO_LABEL[kind],
                    }))}
                />
            </div>

            <MedicalProgramModalContent
                eventType={selectedEventType}
                form={form}
                onCancel={handleCancel}
                {...props}
            />
        </Modal>
    );
};

const MedicalProgramModalContent = ({
    form,
    onCancel,
    onSubmit,
    programType,
    programData,
    eventType,
    hasAppointments = false,
}) => {
    const providerConfig = PROVIDER_CONFIG;
    const provider = PROVIDER;

    const isProgramCompleted = Form.useWatch('completed_program', form);
    const selectedProgramIncompletionReason = Form.useWatch(
        'program_incompletion_reason',
        form
    );
    const selectedCountry = Form.useWatch('country', form);
    const selectedProgramType = Form.useWatch('program_type', form);
    const startDate = Form.useWatch('start_date', form);
    const endDate = Form.useWatch('end_date', form);
    const isPresent = Form.useWatch('is_present', form);

    const handleAddressPlaceChanged = useCallback(
        ({ line_1, country, address_state, city, postal_code }) => {
            form.setFieldsValue({
                line_1,
                state: address_state,
                city,
                country,
                postal_code,
            });
        },
        [form]
    );

    useEffect(() => {
        form.setFieldsValue({ program_type: undefined });
        if (eventType === 'work') {
            form.setFieldsValue({ program_type: 'medical_practice' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventType]);

    const showModalContent = selectedProgramType || eventType === 'work';

    const SectionField = useMemo(
        () => createSectionField('education', providerConfig, true),
        [providerConfig]
    );

    useEffect(() => {
        form.resetFields();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isEndDateRequired = !(
        isPresent || selectedProgramIncompletionReason === 'in_process'
    );
    const isEndDateRequiredOnboardingConfig =
        providerConfig.sections.education.medical_programs.medical_program_end_date;

    const handleSubmit = async (values) => {
        const formData = prepareFormValues(values);
        onSubmit?.(formData);
        notification.success({
            message: `${getConstantLabelOld(
                'medicalPrograms',
                selectedProgramType
            )} successfully added!`,
        });
        onCancel();
    };

    const admittingPrivilegesApplicable = useMemo(() => {
        return eventType === 'work' && ['MD', 'DO'].includes(provider.profession);
    }, [provider.profession, eventType]);

    const getInitialFormValues = (programData) => {
        if (!programData) {
            return {
                completed_program: true,
                program_type: programType,
                contacts: [emptyContact],
            };
        }
        if (programData?.contacts?.length === 0) {
            programData.contacts = [emptyContact];
        }
        return programData;
    };

    return (
        <Form
            id="medical-program-modal-form"
            requiredMark={false}
            form={form}
            layout="vertical"
            name="onboarding-education"
            initialValues={getInitialFormValues(programData)}
            onFinish={handleSubmit}
        >
            <SectionField
                hidden={eventType === 'work'}
                name="program_type"
                subsectionName="medical_programs"
                label="Program Type"
                overrideConfig={eventType !== 'work'}
            >
                <Select
                    showSearch
                    placeholder="Select..."
                    optionFilterProp="label"
                    options={medicalPrograms.filter(
                        (medicalProgram) => medicalProgram.kind === eventType
                    )}
                />
            </SectionField>

            {showModalContent ? (
                <>
                    <SectionField
                        name="institution_name"
                        subsectionName="medical_programs"
                        label="Institution Name"
                        overrideConfig
                    >
                        <InstitutionAutocomplete
                            onSelect={(hit) => {
                                form.setFieldsValue({
                                    line_1: hit.address,
                                    line_2: hit.address_2,
                                    state: hit.state,
                                    city: hit.city,
                                    country: hit.country,
                                    postal_code: hit.zip,
                                });
                            }}
                        />
                    </SectionField>
                    {[
                        'associates',
                        'undergrad',
                        'masters',
                        'md',
                        'nursing_graduate_program',
                        'phd',
                        'jd',
                    ].includes(selectedProgramType) && (
                        <SectionField
                            name="degree_earned"
                            subsectionName="medical_programs"
                            label="Degree"
                        >
                            <ClearableSelect
                                showSearch
                                placeholder="Select..."
                                optionFilterProp="label"
                                options={degrees}
                            />
                        </SectionField>
                    )}
                    {[
                        'fellowship',
                        'internship',
                        'residency',
                        'medical_practice',
                    ].includes(selectedProgramType) && (
                        <Form.Item
                            name="specialty"
                            label={
                                <span>
                                    {'Specialty '}
                                    <span
                                        style={{
                                            color: '#6C6C74',
                                            fontStyle: 'italic',
                                        }}
                                    >
                                        - optional
                                    </span>
                                </span>
                            }
                        >
                            <SpecialtyAutocomplete />
                        </Form.Item>
                    )}

                    {'work' === eventType && (
                        <React.Fragment>
                            <SectionField
                                name="title"
                                subsectionName="medical_programs"
                                label="Title"
                            >
                                <Input />
                            </SectionField>
                            <SectionField
                                name="is_present"
                                subsectionName="medical_programs"
                                valuePropName="checked"
                            >
                                <Checkbox
                                    onChange={() =>
                                        form.setFieldsValue({ end_date: null })
                                    }
                                >
                                    I am currently working in this role
                                </Checkbox>
                            </SectionField>
                        </React.Fragment>
                    )}

                    <Row justify="space-between">
                        <Col span={11}>
                            <SectionField
                                name="start_date"
                                subsectionName="medical_programs"
                                configName="medical_program_start_date"
                                label="Start Date"
                                overrideConfig
                            >
                                <DatePicker
                                    style={{ width: '100%' }}
                                    disabledDate={(date) =>
                                        startDateDisabled(date, endDate) ||
                                        isBefore(date, minDate)
                                    }
                                />
                            </SectionField>
                        </Col>
                        <Col span={11} offset={1}>
                            <Form.Item shouldUpdate noStyle>
                                {() =>
                                    'work' === eventType && isPresent ? (
                                        <Text>Present</Text>
                                    ) : (
                                        <SectionField
                                            name="end_date"
                                            subsectionName="medical_programs"
                                            configName="medical_program_end_date"
                                            label="End Date"
                                            dependencies={['start_date']}
                                            required={isEndDateRequired}
                                            rules={[
                                                {
                                                    required:
                                                        isEndDateRequiredOnboardingConfig &&
                                                        isEndDateRequired,
                                                },
                                                () => ({
                                                    validator:
                                                        getEndDateValidator(startDate),
                                                }),
                                            ]}
                                        >
                                            <DatePicker
                                                style={{ width: '100%' }}
                                                disabledDate={(date) =>
                                                    endDateDisabled(startDate, date) ||
                                                    isBefore(date, minDate)
                                                }
                                            />
                                        </SectionField>
                                    )
                                }
                            </Form.Item>
                        </Col>
                    </Row>

                    {eventType !== 'work' && (
                        <SectionField
                            name="completed_program"
                            subsectionName="medical_programs"
                            label={
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <div>Did you complete this program?</div>
                                    <Tooltip title="State boards require us to submit any information about an incomplete degree.">
                                        <InfoCircleOutlined
                                            style={{
                                                color: '#BFBFBF',
                                                marginLeft: 5,
                                            }}
                                        />
                                    </Tooltip>
                                </div>
                            }
                        >
                            <Radio.Group>
                                <Radio value={true}>Yes</Radio>
                                <Radio value={false}>No</Radio>
                            </Radio.Group>
                        </SectionField>
                    )}

                    {eventType !== 'work' && !isProgramCompleted && (
                        <SectionField
                            name="program_incompletion_reason"
                            subsectionName="medical_programs"
                            label="Program Incompletion Reason"
                        >
                            <ClearableSelect
                                showSearch
                                placeholder="Select..."
                                optionFilterProp="label"
                                options={medicalProgramIncompleteReason}
                            />
                        </SectionField>
                    )}

                    {admittingPrivilegesApplicable && (
                        <Form.Item
                            name="admitting_privileges"
                            label="Admitting Privileges?"
                            rules={[{ required: true }]}
                        >
                            <Radio.Group>
                                <Radio value={true}>Yes</Radio>
                                <Radio value={false}>No</Radio>
                            </Radio.Group>
                        </Form.Item>
                    )}

                    <SectionField
                        name="notes"
                        subsectionName="medical_programs"
                        label="Additional Notes"
                        required={false}
                        overrideConfig={true}
                    >
                        <Input.TextArea />
                    </SectionField>

                    <Divider />
                    <Paragraph>
                        <Text strong> Institution Address</Text>
                    </Paragraph>

                    <SectionField
                        name="line_1"
                        subsectionName="medical_programs"
                        configName="medical_program_line_1"
                        label="Street Address"
                    >
                        <Input />
                    </SectionField>

                    <SectionField
                        name="line_2"
                        subsectionName="medical_programs"
                        configName="medical_program_line_2"
                        label="Street Address 2"
                    >
                        <Input />
                    </SectionField>

                    <div className="field-block-list">
                        <SectionField
                            name="city"
                            subsectionName="medical_programs"
                            configName="medical_program_city"
                            label="City"
                        >
                            <Input />
                        </SectionField>
                        <SectionField
                            name="state"
                            configName="medical_program_state"
                            subsectionName="medical_programs"
                            label="State"
                            overrideConfig={true}
                            required={selectedCountry === 'US'}
                        >
                            {selectedCountry === 'US' ? (
                                <ClearableSelect
                                    showSearch
                                    placeholder="Select..."
                                    optionFilterProp="label"
                                    options={states}
                                />
                            ) : (
                                <Input />
                            )}
                        </SectionField>
                    </div>

                    <div className="field-block-list">
                        <SectionField
                            name="country"
                            subsectionName="medical_programs"
                            configName="medical_program_country"
                            label="Country"
                        >
                            <ClearableSelect
                                showSearch
                                placeholder="Select..."
                                optionFilterProp="label"
                                options={countries}
                            />
                        </SectionField>
                        <SectionField
                            name="postal_code"
                            subsectionName="medical_programs"
                            configName="medical_program_postal_code"
                            label="Postal / Zip Code"
                        >
                            {selectedCountry === 'US' ? <USPostalCodeInput /> : <Input />}
                        </SectionField>
                    </div>

                    <div>
                        <SectionField
                            name="phone_number"
                            subsectionName="medical_programs"
                            configName="medical_program_phone_number"
                            label="Phone Number"
                            additionalRules={[
                                {
                                    pattern: /^\d{3}-\d{3}-\d{4}$/,
                                    message:
                                        'Phone number must be in format 123-456-7890',
                                },
                            ]}
                        >
                            <MaskedInput mask="999-999-9999" placeholder="123-456-7890" />
                        </SectionField>
                    </div>

                    <Divider />

                    {eventType !== 'work' &&
                        ![undefined, '', 'US', 'CA'].includes(selectedCountry) &&
                        ['MD', 'DO'].includes(provider.profession) &&
                        selectedProgramType === 'md' && (
                            <>
                                <Paragraph>
                                    <div
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                        }}
                                    >
                                        <Text strong>ECFMG Info</Text>
                                        <Tooltip
                                            placement="right"
                                            title="The ECMFG accredits international educational institutions outside of the U.S. and Canada."
                                        >
                                            <InfoCircleOutlined
                                                style={{
                                                    color: '#BFBFBF',
                                                    marginLeft: 5,
                                                }}
                                            />
                                        </Tooltip>
                                    </div>
                                </Paragraph>

                                <Row gutter={[16, 8]}>
                                    <Col span={12}>
                                        <SectionField
                                            name="ecfmg_identifier"
                                            subsectionName="medical_programs"
                                            label="Identifier #"
                                            required={true}
                                            overrideConfig={true}
                                        >
                                            <Input />
                                        </SectionField>
                                    </Col>
                                    <Col span={12}>
                                        <SectionField
                                            name="ecfmg_certificate"
                                            subsectionName="medical_programs"
                                            configName="medical_program_ecfmg_certificate"
                                            label="Certificate"
                                            required={true}
                                            overrideConfig={true}
                                        >
                                            <Button style={{ width: '100%' }}>
                                                Upload file
                                            </Button>
                                        </SectionField>
                                    </Col>
                                </Row>
                            </>
                        )}

                    {hasAppointments && <ContactForm />}

                    <div className="ant-modal-footer modal-form-footer">
                        <Button onClick={onCancel} type="link">
                            Cancel
                        </Button>
                        <Button type="primary" htmlType="submit">
                            Submit
                        </Button>
                    </div>
                </>
            ) : (
                <div style={{ marginTop: 20, marginBottom: 50 }}>
                    <Divider />
                </div>
            )}
        </Form>
    );
};

const ContactForm = () => (
    <Form.List name="contacts">
        {(fields, { add, remove }) => (
            <>
                {fields.map(({ name, key }) => (
                    <React.Fragment key={key}>
                        <Row justify="space-between" align="middle">
                            <Col>
                                <Paragraph>
                                    <Text strong>Contact</Text>
                                </Paragraph>
                            </Col>
                            <Col>
                                <Button
                                    onClick={() => remove(name)}
                                    icon={<CloseOutlined />}
                                    size="small"
                                >
                                    Remove
                                </Button>
                            </Col>
                        </Row>
                        <Form.Item name={[name, 'id']} hidden={true} />
                        <div className="field-block-list">
                            <Form.Item name={[name, 'first_name']} label="First Name">
                                <Input />
                            </Form.Item>
                            <Form.Item name={[name, 'last_name']} label="Last Name">
                                <Input />
                            </Form.Item>
                        </div>
                        <Form.Item name={[name, 'email']} label="Email">
                            <Input />
                        </Form.Item>
                        <Form.Item name={[name, 'phone_number']} label="Phone Number">
                            <Input />
                        </Form.Item>
                        {key + 1 !== fields.length && <Divider />}
                    </React.Fragment>
                ))}
                <Button onClick={() => add(emptyContact)} icon={<PlusCircleOutlined />}>
                    Add additional contact
                </Button>
            </>
        )}
    </Form.List>
);

export default MedicalProgramModal;
