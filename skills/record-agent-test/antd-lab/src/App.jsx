// AntD Lab entry page: one button opens the MedicalProgramModal replica.
// Submitted records render as cards (like Medallion's EventCard) with
// data-testids so the studio's assert verb has stable, input-derived targets.
// URL param ?appointments=1 enables the Form.List contacts section.
import React, { useState } from 'react';
import { Button, Card, Typography, Empty, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import MedicalProgramModal from './MedicalProgramModal';
import medicalPrograms from './constants/medical_program.json';
import degrees from './constants/degree.json';
import { formatDate } from './helpers';

const { Title, Text } = Typography;

const programLabel = (value) =>
    medicalPrograms.find((p) => p.value === value)?.label ?? value;
const degreeLabel = (value) => degrees.find((d) => d.value === value)?.label ?? value;

const fmt = (iso) => (iso ? formatDate(iso, 'MMM d, yyyy').toUpperCase() : null);

const App = () => {
    const [visible, setVisible] = useState(false);
    const [records, setRecords] = useState([]);
    const hasAppointments = new URLSearchParams(window.location.search).has(
        'appointments'
    );

    return (
        <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 24px' }}>
            <Title level={3}>AntD Lab — Education (Medallion replica)</Title>
            <Text type="secondary">
                Dr. Grace Hopper, MD · antd 4.24.0 · the exact MedicalProgramModal widgets
            </Text>

            <div style={{ margin: '24px 0' }}>
                <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => setVisible(true)}
                >
                    Add an education record
                </Button>
            </div>

            <div data-testid="education-list">
                {records.length === 0 ? (
                    <Empty description="No education records yet" />
                ) : (
                    records.map((r, i) => (
                        <Card
                            key={i}
                            data-testid="education-record"
                            style={{ marginBottom: 12 }}
                            title={r.institution_name}
                            extra={
                                r.completed_program === false && (
                                    <Tag color="orange">Program Not Completed</Tag>
                                )
                            }
                        >
                            <div>
                                <Text strong>{programLabel(r.program_type)}</Text>
                                {r.degree_earned && (
                                    <Text> · {degreeLabel(r.degree_earned)}</Text>
                                )}
                            </div>
                            <div>
                                <Text type="secondary">
                                    {fmt(r.start_date)} – {fmt(r.end_date) ?? 'PRESENT'}
                                </Text>
                            </div>
                            <div>
                                <Text type="secondary">
                                    {[r.city, r.state, r.country]
                                        .filter(Boolean)
                                        .join(', ')}
                                </Text>
                            </div>
                        </Card>
                    ))
                )}
            </div>

            <MedicalProgramModal
                visible={visible}
                kind="education"
                hasAppointments={hasAppointments}
                onCancel={() => setVisible(false)}
                onSubmit={(record) => setRecords((prev) => [...prev, record])}
            />
        </div>
    );
};

export default App;
