const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const XLSX = require('xlsx');
const path = require('path');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Supabase подключение с WebSocket поддержкой
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    transport: WebSocket
  }
});

// ... остальной код API без изменений ...
// ========== API ==========

// Получить все товары
app.get('/api/products', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Регистрация
app.post('/api/register', async (req, res) => {
  const { email, password, phone } = req.body;
  try {
    // Проверяем существует ли пользователь
    const { data: existing } = await supabase.from('users').select('id').eq('email', email);
    if (existing && existing.length > 0) {
      return res.status(400).json({error: 'Email уже существует'});
    }
    
    const { data, error } = await supabase
      .from('users')
      .insert([{ email, password, phone }])
      .select();
    
    if (error) throw error;
    res.json({success: true, userId: data[0].id});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Логин
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, phone')
      .eq('email', email)
      .eq('password', password);
    
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(401).json({error: 'Неверный email или пароль'});
    }
    
    res.json({success: true, user: data[0]});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Оформление заказа
app.post('/api/orders', async (req, res) => {
  const { user_id, user_email, user_phone, pickup_point, payment_method, total, items } = req.body;
  try {
    // Проверяем наличие товаров
    for (const item of items) {
      const { data: product } = await supabase
        .from('products')
        .select('stock')
        .eq('id', item.id);
      
      if (!product || product.length === 0 || product[0].stock < item.quantity) {
        return res.status(400).json({error: `Товар "${item.name}" недоступен`});
      }
    }
    
    // Уменьшаем склад
    for (const item of items) {
      const { data: product } = await supabase
        .from('products')
        .select('stock')
        .eq('id', item.id);
      
      const newStock = product[0].stock - item.quantity;
      await supabase.from('products').update({ stock: newStock }).eq('id', item.id);
    }
    
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + 1);
    
    const { data, error } = await supabase
      .from('orders')
      .insert([{
        user_id, user_email, user_phone, pickup_point,
        payment_method, total, delivery_date: deliveryDate.toISOString(),
        items: JSON.stringify(items)
      }])
      .select();
    
    if (error) throw error;
    res.json({success: true, orderId: data[0].id, deliveryDate: deliveryDate.toLocaleDateString('ru-RU')});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Получить заказы пользователя
app.get('/api/orders/:email', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_email', req.params.email)
      .order('order_date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Все заказы
app.get('/api/all-orders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('order_date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Отменить заказ
app.put('/api/orders/:id/cancel', async (req, res) => {
  try {
    // Сначала получаем заказ
    const { data: order } = await supabase
      .from('orders')
      .select('items')
      .eq('id', req.params.id);
    
    if (order && order.length > 0 && order[0].items) {
      const items = JSON.parse(order[0].items);
      for (const item of items) {
        const { data: product } = await supabase
          .from('products')
          .select('stock')
          .eq('id', item.id);
        
        if (product && product.length > 0) {
          const newStock = product[0].stock + item.quantity;
          await supabase.from('products').update({ stock: newStock }).eq('id', item.id);
        }
      }
    }
    
    const { error } = await supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id);
    
    if (error) throw error;
    res.json({success: true});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Поиск товаров
app.get('/api/products/search/:query', async (req, res) => {
  try {
    const searchTerm = req.params.query;
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .or(`name.ilike.%${searchTerm}%,category.ilike.%${searchTerm}%,characteristics.ilike.%${searchTerm}%`);
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Статистика
app.get('/api/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('total, status')
      .neq('status', 'cancelled');
    
    if (error) throw error;
    
    const totalOrders = data ? data.length : 0;
    const totalRevenue = data ? data.reduce((sum, order) => sum + order.total, 0) : 0;
    res.json({total_orders: totalOrders, total_revenue: totalRevenue});
  } catch (err) {
    res.json({total_orders: 0, total_revenue: 0});
  }
});

// Техподдержка
app.post('/api/support', (req, res) => {
  console.log('Support request:', req.body);
  res.json({success: true, status: 'offline', message: 'Техподдержка в оффлайн режиме'});
});

// Экспорт в Excel
app.get('/api/export-excel', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = supabase.from('orders').select('*');
    
    if (startDate && endDate) {
      query = query.gte('order_date', startDate).lte('order_date', endDate);
    }
    
    const { data: orders, error } = await query.order('order_date', { ascending: false });
    if (error) throw error;
    
    const excelData = orders.map(order => ({
      'ID заказа': order.id,
      'Дата заказа': order.order_date,
      'Дата готовности': order.delivery_date,
      'Email клиента': order.user_email,
      'Телефон': order.user_phone,
      'Пункт выдачи': order.pickup_point,
      'Оплата': order.payment_method,
      'Сумма (₽)': order.total,
      'Статус': order.status === 'processing' ? 'Активен' : 'Отменён',
      'Товары': order.items
    }));
    
    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Заказы');
    const filename = `orders_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.xlsx`;
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

// Отчёты
app.get('/reports.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});