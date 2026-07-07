// Faithful copy of medallion components/DatePicker/DatePicker.tsx (TS stripped,
// showTime/confirmChange paths kept but unused by the modal). This is the widget
// whose commit semantics caused the codegen saga: typed text only commits via the
// onKeyDown parser (per-keystroke) or a calendar-cell click — a programmatic
// fill() that fires no keydown events reverts on blur.
import React, { useMemo } from 'react';
import generatePicker from 'antd/es/date-picker/generatePicker';
import { parseISO } from 'date-fns';
import { defer, noop, trim } from 'lodash';
import { dateFormats, formatDate } from '../helpers';
import dateFnsConfig from './dateFnsConfig';

const DateFNSPicker = generatePicker(dateFnsConfig);

const DatePicker = React.forwardRef(
    (
        {
            value,
            onChange = noop,
            onKeyDown = noop,
            disabledDate = () => false,
            confirmChange,
            autoSelectOnFocus = false,
            ...props
        },
        ref
    ) => {
        const dateValue = useMemo(() => {
            if (!value) return null;
            if (typeof value === 'string') return parseISO(value);
            return value;
        }, [value]);

        const handleOnChange = async (newValue, dateString) => {
            const shouldTriggerChange = confirmChange
                ? await confirmChange(newValue, dateValue)
                : true;
            if (shouldTriggerChange) {
                onChange(formatDate(newValue, 'yyyy-MM-dd'), dateString);
            }
        };

        const handleOnKeyDown = (e, preventDefault) => {
            onKeyDown(e, preventDefault);

            // hit "Enter"
            if (e.keyCode === 13) {
                if (typeof ref === 'object' && ref?.current) {
                    ref.current.blur();
                }
                return;
            }

            const target = e.target;
            // wait for value is filled
            defer(() => {
                const newValue = target.value;

                // Skip parsing if input length can't match any date format
                const MIN_FORMAT_LENGTH = Math.min(...dateFormats.map((f) => f.length));
                if (trim(newValue).length < MIN_FORMAT_LENGTH) return;

                const date = dateFnsConfig.locale.parse('', newValue, dateFormats);
                if (date && !disabledDate(date)) {
                    const formatted = formatDate(date, 'yyyy-MM-dd');
                    if (formatted && formatted !== value) {
                        onChange(formatted, '');
                    }
                }
            });
        };

        const handleOnFocus = (e) => {
            if (autoSelectOnFocus) {
                e.target.select();
            }
        };

        return (
            <DateFNSPicker
                ref={ref}
                autoComplete="off"
                placeholder="MM/DD/YYYY"
                style={{ width: '100%' }}
                format={dateFormats}
                onFocus={handleOnFocus}
                {...props}
                value={dateValue}
                disabledDate={disabledDate}
                onKeyDown={handleOnKeyDown}
                onChange={handleOnChange}
            />
        );
    }
);

export default DatePicker;
