// Minimal copies of the medallion helpers the modal depends on.
import { format, parseISO, isValid, isAfter, isBefore, parse } from 'date-fns';
import { isString, isNil } from 'lodash';
import medicalPrograms from '../constants/medical_program.json';

// helpers/index.tsx
export const dateFormats = ['MM/DD/YYYY', 'YYYY/MM/DD', 'MM-DD-YYYY', 'YYYY-MM-DD'];

export const formatDate = (date, formatString = 'MM/dd/yyyy') => {
    if (!date) return null;
    let validDate = date;
    if (isString(date)) {
        validDate = parseISO(date);
    }
    return isValid(validDate) ? format(validDate, formatString) : null;
};

export const getConstantLabelOld = (_group, value) =>
    medicalPrograms.find((p) => p.value === value)?.label ?? value;

// helpers/dateRangeHelpers.ts
export const startDateDisabled = (startDate, endDate) => {
    if (isNil(endDate)) {
        return false;
    }
    return !startDate || isAfter(startDate, new Date(endDate));
};

export const endDateDisabled = (startDate, endDate) => {
    if (isNil(startDate)) {
        return false;
    }
    return !endDate || isBefore(endDate, new Date(startDate));
};

export const getEndDateValidator = (startDate) => {
    return async (_, value) => {
        const hasError =
            value &&
            startDate &&
            isBefore(parse(value, 'yyyy-MM-dd', new Date()), new Date(startDate));
        if (hasError) {
            throw new Error('Selected date should be after Start Date');
        }
    };
};

// helpers/medicalProgram.ts
export const getMedicalProgramKinds = () => [
    ...new Set(medicalPrograms.map((program) => program.kind)),
];
