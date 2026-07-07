// Copy of medallion components/MaskedInput/index.tsx (copyable variant dropped).
import React from 'react';
import { Input } from 'antd';
import InputMask from 'react-input-mask';
import { toString } from 'lodash';

const MaskedInput = ({ copyable, disabled, value, ...restProps }) => (
    <InputMask
        maskPlaceholder=""
        disabled={disabled}
        {...restProps}
        value={value && toString(value)}
    >
        <Input />
    </InputMask>
);

export const USPostalCodeInput = (props) => (
    <MaskedInput placeholder="12345" mask="99999" {...props} />
);

export default MaskedInput;
