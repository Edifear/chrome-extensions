// Faithful copy of medallion components/ClearableSelect/index.tsx (TS stripped).
import React, { useContext } from 'react';
import { Select } from 'antd';
import { FieldContext } from './createSectionField';

const ClearableSelect = ({ children, overrideDefaultClear = false, ...props }) => {
    const { isRequired } = useContext(FieldContext);

    return (
        <Select
            onClear={() => {
                setTimeout(() => {
                    props.onChange?.(null);
                }, 0);
            }}
            allowClear={isRequired === false || overrideDefaultClear}
            {...props}
        >
            {children}
        </Select>
    );
};

export default ClearableSelect;
