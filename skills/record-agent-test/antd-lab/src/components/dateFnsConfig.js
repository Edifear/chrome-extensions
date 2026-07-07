// Faithful copy of medallion frontend_service/src/components/DatePicker/dateFnsConfig.ts
// (TS types stripped). Originally copied and modified from
// https://github.com/react-component/picker/blob/master/src/generate/dateFns.ts
import {
    getDay,
    getYear,
    getMonth,
    getDate,
    endOfMonth,
    getHours,
    getMinutes,
    getSeconds,
    addYears,
    addMonths,
    addDays,
    setYear,
    setMonth,
    setDate,
    setHours,
    setMinutes,
    setSeconds,
    isAfter,
    isValid,
    getWeek,
    startOfWeek,
    format as formatDate,
    parse as parseDate,
} from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import { trim } from 'lodash';

export const localeParse = (format) => {
    return format
        .replace(/Y/g, 'y')
        .replace(/D/g, 'd')
        .replace(/gggg/, 'yyyy')
        .replace(/g/g, 'G')
        .replace(/([Ww])o/g, 'wo');
};

const generateConfig = {
    // get
    getNow: () => new Date(),
    getFixedDate: (string) => new Date(string),
    getEndDate: (date) => endOfMonth(date),
    getWeekDay: (date) => getDay(date),
    getYear: (date) => getYear(date),
    getMonth: (date) => getMonth(date),
    getDate: (date) => getDate(date),
    getHour: (date) => getHours(date),
    getMinute: (date) => getMinutes(date),
    getSecond: (date) => getSeconds(date),

    // set
    addYear: (date, diff) => addYears(date, diff),
    addMonth: (date, diff) => addMonths(date, diff),
    addDate: (date, diff) => addDays(date, diff),
    setYear: (date, year) => setYear(date, year),
    setMonth: (date, month) => setMonth(date, month),
    setDate: (date, num) => setDate(date, num),
    setHour: (date, hour) => setHours(date, hour),
    setMinute: (date, minute) => setMinutes(date, minute),
    setSecond: (date, second) => setSeconds(date, second),

    // Compare
    isAfter: (date1, date2) => isAfter(date1, date2),
    isValidate: (date) => isValid(date),

    locale: {
        getWeekFirstDay: () => enUS.options?.weekStartsOn ?? 0,
        getWeekFirstDate: (_locale, date) => startOfWeek(date, { locale: enUS }),
        getWeek: (_locale, date) => getWeek(date, { locale: enUS }),
        getShortWeekDays: () =>
            Array.from({ length: 7 }).map((_, i) =>
                enUS.localize.day(i, { width: 'short' })
            ),
        getShortMonths: () =>
            Array.from({ length: 12 }).map((_, i) =>
                enUS.localize.month(i, { width: 'abbreviated' })
            ),
        format: (_locale, date, format) => {
            if (!isValid(date)) {
                return '';
            }
            return formatDate(date, localeParse(format), { locale: enUS });
        },
        parse: (_locale, text, formats) => {
            for (let i = 0; i < formats.length; i += 1) {
                const format = localeParse(formats[i]);
                const formatText = text;
                const date = parseDate(formatText, format, new Date(), {
                    locale: enUS,
                });

                // Workaround: date-fns parse() is lenient — e.g. "07" parses as year 7 for "yyyy".
                const isValidFormat = trim(format).length === trim(text).length;

                if (isValidFormat && isValid(date)) {
                    return date;
                }
            }

            return null;
        },
    },
};

export default generateConfig;
